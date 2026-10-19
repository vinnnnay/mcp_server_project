-- Makes appending to the audit log safe under concurrency.
--
-- The adapter used to read the chain head over the REST API and then insert the
-- next entry, which is a read-then-write race: five concurrent proposals left
-- one entry and four `duplicate key value violates unique constraint
-- "audit_log_pkey"` errors. Losing an audit write is worse than it looks, since
-- the gate audits refusals too.
--
-- append_audit already serializes on an advisory lock, so the fix is to let the
-- adapter call it rather than reimplement it. This returns the whole sealed
-- entry so the caller still gets what it inserted.

drop function if exists append_audit(text, text, uuid, jsonb, text, text, text, jsonb);

create or replace function append_audit(
  p_actor        text,
  p_action       text,
  p_approval_id  uuid,
  p_operation    jsonb,
  p_payload_hash text,
  p_outcome      text,
  p_error_code   text,
  p_diff         jsonb,
  p_ts           timestamptz default null
)
returns jsonb
language plpgsql
as $$
declare
  v_seq   bigint;
  v_prev  text;
  v_ts    timestamptz := date_trunc('milliseconds', coalesce(p_ts, now()));
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

  return v_entry || jsonb_build_object('entry_hash', v_hash);
end;
$$;
