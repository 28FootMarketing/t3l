-- Communications module (project neptxzpueslyzfgaktez). Service-role only (the
-- t3l-portal edge function mediates all access). Two channels:
--   * Portal announcements (t3l_announcements) — shown in the member portal "Updates".
--   * Email broadcasts via Resend (logged in t3l_comms_email_log; sent by the function).

create table if not exists public.t3l_announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  published  boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists t3l_announcements_pub_idx
  on public.t3l_announcements (published, created_at desc);

create table if not exists public.t3l_comms_email_log (
  id         uuid primary key default gen_random_uuid(),
  subject    text not null,
  audience   text not null,                 -- human label, e.g. 'All members' or 'CRM: donors'
  recipients int not null default 0,
  sent       int not null default 0,
  failed     int not null default 0,
  status     text not null default 'sent',  -- sent | partial | failed | no_recipients | not_configured
  error      text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists t3l_comms_email_log_idx
  on public.t3l_comms_email_log (created_at desc);

-- Default "from" address for email broadcasts; editable (stored in portal config).
insert into public.t3l_portal_config (key, value)
values ('comms_from_email', 'Teach Them to Love <outreach@mail.28footsystems.com>')
on conflict (key) do nothing;

alter table public.t3l_announcements   enable row level security;
alter table public.t3l_comms_email_log enable row level security;
