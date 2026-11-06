-- T3L portal content support (project neptxzpueslyzfgaktez).
-- Server-only stores, reachable only via the service role (the t3l-portal
-- edge function). No RLS policies => not readable/writable by anon/authenticated.

-- Holds the gated admin-console markup (key = 'admin_app'); served by the
-- function's `app` action only to a verified admin/super session, and seeded
-- via POST ?action=seed_app (first write, or a super admin thereafter).
create table if not exists public.t3l_portal_assets (
  key text primary key,
  content text not null,
  updated_at timestamptz not null default now()
);

-- Shared admin configuration, e.g. the GoHighLevel workflow webhook URLs the
-- content tools (announcements/events/resources/prayer) post to.
create table if not exists public.t3l_portal_config (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table public.t3l_portal_assets enable row level security;
alter table public.t3l_portal_config enable row level security;
