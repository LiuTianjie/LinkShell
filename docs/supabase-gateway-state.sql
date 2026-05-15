-- Optional persistence for the official LinkShell gateway v2.
-- The gateway falls back to in-memory state when these tables are absent.
-- v2 is intentionally breaking: host devices and client authorizations replace
-- the old session token/session pairing tables.

create table if not exists public.linkshell_gateway_device_authorizations (
  authorization_id text primary key,
  token text not null,
  host_device_id text not null,
  client_device_id text,
  client_name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (token, host_device_id)
);

create table if not exists public.linkshell_gateway_pairing_challenges (
  pairing_code text primary key,
  host_device_id text not null,
  expires_at timestamptz not null,
  claimed boolean not null default false
);

alter table public.linkshell_gateway_device_authorizations enable row level security;
alter table public.linkshell_gateway_pairing_challenges enable row level security;

drop policy if exists "service role manages gateway device authorizations"
  on public.linkshell_gateway_device_authorizations;
create policy "service role manages gateway device authorizations"
  on public.linkshell_gateway_device_authorizations
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "service role manages gateway pairing challenges"
  on public.linkshell_gateway_pairing_challenges;
create policy "service role manages gateway pairing challenges"
  on public.linkshell_gateway_pairing_challenges
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create index if not exists linkshell_gateway_device_authorizations_token_idx
  on public.linkshell_gateway_device_authorizations (token);

create index if not exists linkshell_gateway_device_authorizations_host_idx
  on public.linkshell_gateway_device_authorizations (host_device_id);

create index if not exists linkshell_gateway_pairing_challenges_expires_idx
  on public.linkshell_gateway_pairing_challenges (expires_at);
