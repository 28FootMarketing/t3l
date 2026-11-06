-- Giving module (project neptxzpueslyzfgaktez): funds, gifts, pledges.
-- Service-role only (the t3l-portal edge function mediates all access).
-- Amounts are stored in integer cents. Payments are collected elsewhere
-- (PayPal / Cash App on the site); this module records and reports giving.

create table if not exists public.t3l_giving_funds (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  active     boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);
insert into public.t3l_giving_funds (name, sort)
select v.name, v.sort
from (values ('General Fund',10),('Building Fund',20),('Missions',30),('Benevolence',40)) as v(name, sort)
where not exists (select 1 from public.t3l_giving_funds);

create table if not exists public.t3l_giving_gifts (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid references public.t3l_crm_contacts(id) on delete set null,
  donor_name   text,
  donor_email  text,
  amount_cents integer not null check (amount_cents >= 0),
  fund_id      uuid references public.t3l_giving_funds(id) on delete set null,
  method       text not null default 'other' check (method in ('cash','check','paypal','cashapp','card','other')),
  gift_date    date not null default current_date,
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists t3l_giving_gifts_date_idx  on public.t3l_giving_gifts (gift_date desc);
create index if not exists t3l_giving_gifts_email_idx on public.t3l_giving_gifts (lower(donor_email));
create index if not exists t3l_giving_gifts_fund_idx  on public.t3l_giving_gifts (fund_id);

create table if not exists public.t3l_giving_pledges (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid references public.t3l_crm_contacts(id) on delete set null,
  donor_name   text,
  donor_email  text,
  amount_cents integer not null check (amount_cents >= 0),
  fund_id      uuid references public.t3l_giving_funds(id) on delete set null,
  frequency    text not null default 'monthly' check (frequency in ('one_time','weekly','monthly','yearly')),
  start_date   date,
  end_date     date,
  status       text not null default 'active' check (status in ('active','completed','cancelled')),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.t3l_giving_funds   enable row level security;
alter table public.t3l_giving_gifts    enable row level security;
alter table public.t3l_giving_pledges  enable row level security;
