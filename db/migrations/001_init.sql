-- Outcome API schema. Lives in its own `outcome` schema so Supabase's PostgREST
-- (which exposes `public`) never serves it; RLS is enabled as a second guard.
-- The API connects with a direct Postgres connection string and bypasses RLS as table owner.

create schema if not exists outcome;

-- Every document table has the same shape: the full object in `doc`, plus the few
-- columns the API filters on. `due_at` is when the scheduler next needs to look at it.
do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'api_keys', 'mandates', 'quotes', 'tasks',
    'deliveries', 'settlements', 'webhooks', 'idempotency_keys'
  ] loop
    execute format($f$
      create table if not exists outcome.%1$I (
        id          text primary key,
        ord         bigint generated always as identity,
        account_id  text,
        parent_id   text,
        lookup      text,
        status      text,
        due_at      timestamptz,
        doc         jsonb not null,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now()
      )$f$, t);
    execute format('create index if not exists %1$I on outcome.%2$I (account_id, ord)', t || '_account_idx', t);
    execute format('create index if not exists %1$I on outcome.%2$I (parent_id, ord)', t || '_parent_idx', t);
    execute format('create index if not exists %1$I on outcome.%2$I (due_at) where due_at is not null', t || '_due_idx', t);
    execute format('alter table outcome.%I enable row level security', t);
  end loop;
end $$;

create unique index if not exists api_keys_lookup_idx on outcome.api_keys (lookup);

create table if not exists outcome.events (
  seq         bigserial primary key,
  id          text not null unique,
  account_id  text not null,
  task_id     text not null,
  type        text not null,
  doc         jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists events_task_idx on outcome.events (task_id, seq);
create index if not exists events_account_idx on outcome.events (account_id, seq);
alter table outcome.events enable row level security;
