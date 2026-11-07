-- Events module (project neptxzpueslyzfgaktez). Service-role only (the
-- t3l-portal edge function mediates all access). Replaces the old GoHighLevel
-- webhook event form: events now live in Supabase and show in the member portal.
--
-- Time-to-be-determined: start_time (and end_time) are nullable. A null start_time
-- means "time to be determined" — the portal shows the date only, no time.

create table if not exists public.t3l_events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  location    text,
  description text,
  start_date  date not null,
  start_time  time,            -- null => time to be determined (show date only)
  end_date    date,
  end_time    time,
  published   boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists t3l_events_idx on public.t3l_events (published, start_date);

alter table public.t3l_events enable row level security;
