-- Module on/off registry + CRM (project neptxzpueslyzfgaktez).
-- Service-role only (the t3l-portal edge function mediates all access).

-- Which optional modules are live. Super admin toggles these from the console's
-- Modules screen (set_module). Core tools (People, Prayer care) are always on.
create table if not exists public.t3l_portal_modules (
  key        text primary key,
  enabled    boolean not null default false,
  label      text,
  sort       int not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.t3l_portal_modules (key, enabled, label, sort) values
  ('announcements',  true,  'Announcements',       10),
  ('events',         true,  'Events & programs',   20),
  ('resources',      true,  'Resource library',    30),
  ('crm',            false, 'CRM — Contacts',       40),
  ('giving',         false, 'Giving & donations',  50),
  ('communications', false, 'Communications',      60)
on conflict (key) do nothing;

-- CRM: contacts + an activity/notes timeline.
create table if not exists public.t3l_crm_contacts (
  id         uuid primary key default gen_random_uuid(),
  first_name text,
  last_name  text,
  email      text,
  phone      text,
  stage      text not null default 'new',
  tags       text[] not null default '{}',
  notes      text,
  custom     jsonb not null default '{}'::jsonb,
  status     text not null default 'active' check (status in ('active','archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists t3l_crm_contacts_name_idx  on public.t3l_crm_contacts (lower(last_name), lower(first_name));
create index if not exists t3l_crm_contacts_email_idx on public.t3l_crm_contacts (lower(email));

create table if not exists public.t3l_crm_activities (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.t3l_crm_contacts(id) on delete cascade,
  kind       text not null default 'note' check (kind in ('note','call','email','visit','stage_change','other')),
  body       text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists t3l_crm_activities_contact_idx on public.t3l_crm_activities (contact_id, created_at desc);

alter table public.t3l_portal_modules enable row level security;
alter table public.t3l_crm_contacts   enable row level security;
alter table public.t3l_crm_activities  enable row level security;
