-- Atomic commit path.
--
-- 001 left a gap: the Node gate resolved target rows, checked the precondition
-- hash, and then applied the mutation in a separate statement. Between those
-- steps another writer could change the rows, so E_STATE_DRIFT narrowed the
-- window without closing it.
--
-- This file moves the whole check-and-apply sequence inside one transaction,
-- behind a row lock on the approval and FOR UPDATE locks on every target row.
-- The SQL function is the authority; the Node checks become a fast path that
-- produces better error messages, and can no longer decide the outcome.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------ canonical json --

-- Must agree byte for byte with canonicalize() in src/gate/canonical.ts:
-- keys sorted, no whitespace, scalars rendered compactly. jsonb already sorts
-- object keys, but by length-then-bytes, so the ordering is redone explicitly.
create or replace function canonical_jsonb(doc jsonb)
returns text
language plpgsql
immutable
strict
as $$
declare
  parts text[] := '{}';
  k text;
  item jsonb;
begin
  case jsonb_typeof(doc)
    when 'object' then
      for k in select key from jsonb_object_keys(doc) as key order by key collate "C" loop
        parts := parts || (to_jsonb(k)::text || ':' || canonical_jsonb(doc -> k));
      end loop;
      return '{' || array_to_string(parts, ',') || '}';
    when 'array' then
      for item in select value from jsonb_array_elements(doc) as value loop
        parts := parts || canonical_jsonb(item);
      end loop;
      return '[' || array_to_string(parts, ',') || ']';
    else
      return doc::text;
  end case;
end;
$$;

create or replace function sha256_hex(input text)
returns text
language sql
immutable
strict
set search_path = public, extensions
as $$
  select encode(digest(convert_to(input, 'UTF8'), 'sha256'), 'hex');
$$;

-- Timestamps are hashed in the exact shape Date#toISOString() produces.
create or replace function iso8601(ts timestamptz)
returns text
language sql
immutable
strict
as $$
  select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- ----------------------------------------------------------------- allowlist --

create or replace function gate_allowed_table(p_table text)
returns boolean
language sql
stable
as $$
  select p_table in ('customers', 'support_tickets');
$$;

create or replace function gate_has_column(p_table text, p_column text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = p_table and column_name = p_column
  );
$$;

-- --------------------------------------------------------------- audit chain --

-- Appends one entry under an advisory lock so concurrent commits cannot claim
-- the same sequence number. Mirrors computeEntryHash() in src/audit/chain.ts.
create or replace function append_audit(
  p_actor        text,
  p_action       text,
  p_approval_id  uuid,
  p_operation    jsonb,
  p_payload_hash text,
  p_outcome      text,
  p_error_code   text,
  p_diff         jsonb
)
returns text
language plpgsql
as $$
declare
  v_seq   bigint;
  v_prev  text;
  v_ts    timestamptz := now();
  v_entry jsonb;
  v_hash  text;
begin
  perform pg_advisory_xact_lock(hashtext('audit_log'));

  select seq, entry_hash into v_seq, v_prev
  from audit_log order by seq desc limit 1;

  v_seq  := coalesce(v_seq, 0) + 1;
  v_prev := coalesce(v_prev, repeat('0', 64));

  v_entry := jsonb_build_object(
    'seq',          v_seq,
    'ts',           iso8601(v_ts),
    'actor',        p_actor,
    'action',       p_action,
    'approval_id',  p_approval_id,
    'operation',    p_operation,
    'payload_hash', p_payload_hash,
    'outcome',      p_outcome,
    'error_code',   p_error_code,
    'diff',         p_diff,
    'prev_hash',    v_prev
  );
  v_hash := sha256_hex(canonical_jsonb(v_entry));

  insert into audit_log (
    seq, ts, actor, action, approval_id, operation,
    payload_hash, outcome, error_code, diff, prev_hash, entry_hash
  ) values (
    v_seq, v_ts, p_actor, p_action, p_approval_id, p_operation,
    p_payload_hash, p_outcome, p_error_code, p_diff, v_prev, v_hash
  );

  return v_hash;
end;
$$;

-- ------------------------------------------------------------------- targets --

-- Resolves the rows an operation would touch. With p_lock, every matched row is
-- locked FOR UPDATE in primary-key order, which both pins the precondition and
-- gives concurrent commits a deterministic lock order.
create or replace function operation_target_ids(p_operation jsonb, p_lock boolean default false)
returns text[]
language plpgsql
as $$
declare
  v_table  text := p_operation ->> 'table';
  v_filter jsonb := p_operation -> 'filter';
  v_conds  text[] := '{}';
  v_key    text;
  v_sql    text;
  v_ids    text[];
begin
  if not gate_allowed_table(v_table) then
    raise exception 'E_UNKNOWN_TABLE:%', v_table;
  end if;

  if p_operation ? 'id' then
    v_conds := v_conds || format('t.id = %L', p_operation ->> 'id');
  elsif v_filter is not null and jsonb_typeof(v_filter) = 'object' then
    for v_key in select key from jsonb_object_keys(v_filter) as key order by key collate "C" loop
      if not gate_has_column(v_table, v_key) then
        raise exception 'E_UNKNOWN_COLUMN:%', v_key;
      end if;
      -- Compare as jsonb so numeric/text/boolean all behave the same way.
      v_conds := v_conds || format('to_jsonb(t.%I) = %L::jsonb', v_key, v_filter -> v_key);
    end loop;
  else
    return '{}';
  end if;

  v_sql := format(
    'select coalesce(array_agg(t.id order by t.id collate "C"), ''{}'') from %I t where %s',
    v_table,
    array_to_string(v_conds, ' and ')
  );
  if p_lock then
    -- array_agg cannot be combined with FOR UPDATE, so lock in a prior pass.
    execute format(
      'select coalesce(array_agg(id), ''{}'') from (select t.id from %I t where %s order by t.id collate "C" for update) s',
      v_table,
      array_to_string(v_conds, ' and ')
    ) into v_ids;
    return v_ids;
  end if;

  execute v_sql into v_ids;
  return v_ids;
end;
$$;

-- Hash of the rows a diff was computed against. Used at BOTH propose and commit
-- time, so the two can never disagree about how a row serializes.
create or replace function precondition_hash(p_table text, p_ids text[])
returns text
language plpgsql
stable
as $$
declare
  v_parts text;
begin
  if not gate_allowed_table(p_table) then
    raise exception 'E_UNKNOWN_TABLE:%', p_table;
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return sha256_hex('[]');
  end if;

  execute format(
    'select coalesce(string_agg(c, '','' order by c collate "C"), '''') '
    'from (select canonical_jsonb(to_jsonb(t)) as c from %I t where t.id = any($1)) s',
    p_table
  ) into v_parts using p_ids;

  return sha256_hex('[' || v_parts || ']');
end;
$$;

-- -------------------------------------------------------------------- commit --

create or replace function gate_reject(
  p_actor       text,
  p_approval_id uuid,
  p_operation   jsonb,
  p_payload_hash text,
  p_code        text,
  p_message     text
)
returns jsonb
language plpgsql
as $$
begin
  perform append_audit(
    p_actor, 'reject:' || p_code, p_approval_id, p_operation,
    p_payload_hash, 'rejected', p_code, null
  );
  return jsonb_build_object('status', 'refused', 'error_code', p_code, 'message', p_message);
end;
$$;

create or replace function commit_operation_atomic(p_approval_id uuid, p_actor text)
returns jsonb
language plpgsql
as $$
declare
  p            pending_operations%rowtype;
  v_table      text;
  v_patch      jsonb;
  v_kind       text;
  v_ids        text[];
  v_pre        text;
  v_cols       text[] := '{}';
  v_key        text;
  v_count      int := 0;
  v_new_ids    text[];
  v_now        timestamptz := now();
begin
  -- One commit of a given approval at a time. A concurrent caller blocks here
  -- and then sees status = 'executed', which is what makes replay impossible
  -- rather than merely unlikely.
  select * into p from pending_operations where approval_id = p_approval_id for update;

  if not found then
    return gate_reject(p_actor, p_approval_id, null, null,
      'E_NOT_FOUND', format('no such approval: %s', p_approval_id));
  end if;

  if p.status = 'executed' then
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_ALREADY_EXECUTED', 'this approval was already used; approvals are single-use');
  end if;

  if p.status = 'cancelled' then
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_CANCELLED', 'this proposal was cancelled');
  end if;

  if p.status <> 'approved' then
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_NOT_APPROVED', format('proposal is "%s", not approved by a human', p.status));
  end if;

  if v_now >= p.expires_at then
    update pending_operations set status = 'expired' where approval_id = p_approval_id;
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_EXPIRED', format('approval expired at %s', iso8601(p.expires_at)));
  end if;

  if p.approved_by is null or p.approved_by = p.requested_by then
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_SELF_APPROVAL', 'the requester cannot approve their own operation');
  end if;

  if p.payload_hash is distinct from sha256_hex(canonical_jsonb(p.operation)) then
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_PAYLOAD_TAMPERED', 'stored operation does not match the approved payload hash');
  end if;

  v_table := p.operation ->> 'table';
  v_kind  := p.operation ->> 'kind';
  v_patch := p.operation -> 'patch';

  if not gate_allowed_table(v_table) then
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_UNKNOWN_TABLE', format('no such table: %s', v_table));
  end if;

  if v_kind = 'create' then
    v_ids := '{}';
  else
    v_ids := operation_target_ids(p.operation, true);
  end if;

  v_pre := precondition_hash(v_table, v_ids);
  if v_pre is distinct from p.precondition_hash then
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_STATE_DRIFT', 'underlying rows changed since approval; the approved diff is stale');
  end if;

  if v_patch is not null and jsonb_typeof(v_patch) = 'object' then
    for v_key in select key from jsonb_object_keys(v_patch) as key order by key collate "C" loop
      if not gate_has_column(v_table, v_key) then
        return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
          'E_UNKNOWN_COLUMN', format('unknown column on %s: %s', v_table, v_key));
      end if;
      v_cols := v_cols || v_key;
    end loop;
  end if;

  if v_kind = 'delete' then
    execute format('delete from %I where id = any($1)', v_table) using v_ids;
    get diagnostics v_count = row_count;
    v_new_ids := v_ids;

  elsif v_kind = 'update' then
    if array_length(v_cols, 1) is null then
      return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
        'E_UNKNOWN_COLUMN', 'update has no columns to set');
    end if;
    execute format(
      'update %I t set (%s) = (select %s from jsonb_populate_record(null::%I, $2) r) where t.id = any($1)',
      v_table,
      (select string_agg(quote_ident(c), ', ') from unnest(v_cols) c),
      (select string_agg('r.' || quote_ident(c), ', ') from unnest(v_cols) c),
      v_table
    ) using v_ids, v_patch;
    get diagnostics v_count = row_count;
    v_new_ids := v_ids;

  elsif v_kind = 'create' then
    if array_length(v_cols, 1) is null then
      return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
        'E_UNKNOWN_COLUMN', 'create has no columns to set');
    end if;
    execute format(
      'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1) r returning id',
      v_table,
      (select string_agg(quote_ident(c), ', ') from unnest(v_cols) c),
      (select string_agg('r.' || quote_ident(c), ', ') from unnest(v_cols) c),
      v_table
    ) using v_patch into v_new_ids;
    v_count := coalesce(array_length(v_new_ids, 1), 0);
    v_new_ids := coalesce(v_new_ids, '{}');

  else
    return gate_reject(p_actor, p_approval_id, p.operation, p.payload_hash,
      'E_POLICY_DENIED', format('unsupported operation kind: %s', v_kind));
  end if;

  update pending_operations
     set status = 'executed', executed_at = v_now
   where approval_id = p_approval_id;

  perform append_audit(
    p_actor, 'commit:' || v_kind, p_approval_id, p.operation,
    p.payload_hash, 'ok', null, p.preview
  );

  return jsonb_build_object(
    'status',       'executed',
    'approval_id',  p_approval_id,
    'rows_changed', v_count,
    'ids',          to_jsonb(coalesce(v_new_ids, '{}')),
    'payload_hash', p.payload_hash,
    'approved_by',  p.approved_by
  );
end;
$$;
