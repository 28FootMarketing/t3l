-- T3L portal authentication & roles.
-- Fully isolated from the existing app schema with a t3l_ prefix. No existing
-- table is touched. Project: neptxzpueslyzfgaktez.

create table if not exists public.t3l_portal_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null default 'client' check (role in ('client','admin')),
  full_name  text,
  status     text not null default 'active' check (status in ('active','revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists t3l_portal_members_email_lower_key
  on public.t3l_portal_members (lower(email));

alter table public.t3l_portal_members enable row level security;

-- Admin check that bypasses RLS (SECURITY DEFINER) to avoid recursive policy evaluation.
create or replace function public.t3l_is_portal_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.t3l_portal_members m
    where m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  );
$$;

revoke all on function public.t3l_is_portal_admin() from public;
grant execute on function public.t3l_is_portal_admin() to authenticated, anon, service_role;

-- A member may read their own row; an active admin may read all rows.
-- No insert/update/delete policies => all writes go through the service role
-- (the t3l-portal edge function) only.
drop policy if exists t3l_members_select_self  on public.t3l_portal_members;
create policy t3l_members_select_self on public.t3l_portal_members
  for select using (auth.uid() = user_id);

drop policy if exists t3l_members_select_admin on public.t3l_portal_members;
create policy t3l_members_select_admin on public.t3l_portal_members
  for select using (public.t3l_is_portal_admin());
