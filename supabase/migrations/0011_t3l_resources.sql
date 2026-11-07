-- Resources module (project neptxzpueslyzfgaktez). Service-role only (the
-- t3l-portal edge function mediates all access). Replaces the old GoHighLevel
-- resource webhook form: resources now live in Supabase and show in the member
-- portal's Resource library.

create table if not exists public.t3l_resources (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  url         text not null,
  description text,
  published   boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists t3l_resources_idx on public.t3l_resources (published, created_at desc);

alter table public.t3l_resources enable row level security;
