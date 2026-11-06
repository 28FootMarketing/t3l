-- Deeper CRM (project neptxzpueslyzfgaktez). Service-role only.
-- Custom fields, configurable pipeline stages, households, tasks/reminders.
-- Custom-field VALUES are stored in t3l_crm_contacts.custom (jsonb) keyed by `key`.
-- Giving history links through the existing t3l_giving_gifts.contact_id.

create table if not exists public.t3l_crm_fields (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  type text not null default 'text' check (type in ('text','number','date','select')),
  options text[] not null default '{}',
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.t3l_crm_stages (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  sort int not null default 0,
  active boolean not null default true
);
insert into public.t3l_crm_stages (key, label, sort)
select v.key, v.label, v.sort from (values
  ('new','New',10),('engaged','Engaged',20),('member','Member',30),
  ('volunteer','Volunteer',40),('donor','Donor',50),('inactive','Inactive',60)
) as v(key,label,sort)
where not exists (select 1 from public.t3l_crm_stages);

create table if not exists public.t3l_crm_households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
alter table public.t3l_crm_contacts
  add column if not exists household_id uuid references public.t3l_crm_households(id) on delete set null;

create table if not exists public.t3l_crm_tasks (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.t3l_crm_contacts(id) on delete cascade,
  title text not null,
  due_date date,
  done boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists t3l_crm_tasks_open_idx on public.t3l_crm_tasks (done, due_date);
create index if not exists t3l_crm_tasks_contact_idx on public.t3l_crm_tasks (contact_id);

alter table public.t3l_crm_fields     enable row level security;
alter table public.t3l_crm_stages     enable row level security;
alter table public.t3l_crm_households enable row level security;
alter table public.t3l_crm_tasks      enable row level security;
