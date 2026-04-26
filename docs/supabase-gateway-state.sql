-- Optional persistence for the official LinkShell gateway.
-- The gateway falls back to in-memory state when these tables are absent.

create table if not exists public.linkshell_gateway_tokens (
  token text primary key,
  session_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create table if not exists public.linkshell_gateway_pairings (
  pairing_code text primary key,
  session_id text not null,
  expires_at timestamptz not null,
  claimed boolean not null default false
);

alter table public.linkshell_gateway_tokens enable row level security;
alter table public.linkshell_gateway_pairings enable row level security;

drop policy if exists "service role manages gateway tokens" on public.linkshell_gateway_tokens;
create policy "service role manages gateway tokens"
  on public.linkshell_gateway_tokens
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "service role manages gateway pairings" on public.linkshell_gateway_pairings;
create policy "service role manages gateway pairings"
  on public.linkshell_gateway_pairings
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create index if not exists linkshell_gateway_tokens_last_used_idx
  on public.linkshell_gateway_tokens (last_used_at);

create index if not exists linkshell_gateway_pairings_expires_idx
  on public.linkshell_gateway_pairings (expires_at);
