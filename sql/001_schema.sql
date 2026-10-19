-- Gated MCP server schema for Supabase / Postgres.
-- Run in the Supabase SQL editor, or: psql "$DATABASE_URL" -f sql/001_schema.sql

-- ---------------------------------------------------------------- business --

create table if not exists customers (
  id            text primary key default gen_random_uuid()::text,
  name          text not null,
  email         text,
  phone         text,
  address       text,
  date_of_birth date,
  plan          text not null default 'starter',
  mrr           numeric not null default 0,
  status        text not null default 'active',
  notes         text default ''
);

create table if not exists support_tickets (
  id             text primary key default gen_random_uuid()::text,
  customer_id    text references customers (id) on delete set null,
  subject        text not null,
  body           text default '',
  priority       text not null default 'medium',
  state          text not null default 'open',
  reporter_email text
);

-- ---------------------------------------------------------------- approvals --

create table if not exists pending_operations (
  approval_id       uuid primary key,
  operation         jsonb not null,
  payload_hash      text not null,
  precondition_hash text not null,
  affected_count    int  not null,
  preview           jsonb not null,
  tier              text not null,
  status            text not null default 'pending',
  reason            text not null default '',
  requested_by      text not null,
  approved_by       text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  approved_at       timestamptz,
  executed_at       timestamptz,
  constraint status_values check (
    status in ('pending','approved','denied','executed','expired','cancelled')
  ),
  -- A proposal can only be approved by someone other than its requester.
  constraint no_self_approval check (approved_by is null or approved_by <> requested_by)
);

create index if not exists pending_operations_status_idx
  on pending_operations (status, created_at desc);

-- Once a proposal has executed it is frozen: no later edit can rewrite history.
create or replace function freeze_executed_proposals() returns trigger as $$
begin
  if old.status = 'executed' then
    raise exception 'executed proposals are immutable (approval_id=%)', old.approval_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists pending_operations_freeze on pending_operations;
create trigger pending_operations_freeze
  before update or delete on pending_operations
  for each row execute function freeze_executed_proposals();

-- -------------------------------------------------------------------- audit --

create table if not exists audit_log (
  seq          bigint primary key,
  ts           timestamptz(3) not null,   -- millisecond precision, to match Date#toISOString()
  actor        text not null,
  action       text not null,
  approval_id  uuid,
  operation    jsonb,
  payload_hash text,
  outcome      text not null check (outcome in ('ok','rejected')),
  error_code   text,
  diff         jsonb,
  prev_hash    text not null,
  entry_hash   text not null
);

-- Append-only at the database level. The hash chain makes tampering *detectable*;
-- this makes it *difficult*. Belt and braces, because an audit log that the
-- application can quietly rewrite is not an audit log.
create or replace function reject_audit_mutation() returns trigger as $$
begin
  raise exception 'audit_log is append-only';
end;
$$ language plpgsql;

drop trigger if exists audit_log_no_update on audit_log;
create trigger audit_log_no_update
  before update or delete on audit_log
  for each row execute function reject_audit_mutation();

-- ----------------------------------------------------------------- hardening --

alter table customers           enable row level security;
alter table support_tickets     enable row level security;
alter table pending_operations  enable row level security;
alter table audit_log           enable row level security;

-- No policies are defined, so anon/authenticated keys can read nothing. The MCP
-- server connects with the service role and is itself the access control point;
-- never hand the service key to a client.
