-- Prayer requests submitted from the client portal (project neptxzpueslyzfgaktez).
-- Written by the t3l-portal edge function (service role) on behalf of an
-- authenticated active member. Service-role only (no RLS policies).

create table if not exists public.t3l_prayer_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text,
  email text,
  ministry_role text,
  request text not null,
  status text not null default 'received' check (status in ('received','in_prayer','closed')),
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.t3l_prayer_requests enable row level security;
