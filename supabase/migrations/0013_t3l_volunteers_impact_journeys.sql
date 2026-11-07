-- Volunteer management, impact/transparency, member prayer wall, and automated
-- email journeys for the T3L portal (project neptxzpueslyzfgaktez).
--
-- Service-role only: the t3l-portal edge function mediates every read/write.
-- RLS is enabled on every table with NO policies, which denies all direct
-- anon/authenticated access (the service role bypasses RLS). This matches the
-- rest of the T3L schema (e.g. t3l_prayer_requests).

-- =========================================================================
-- VOLUNTEER MANAGEMENT
-- =========================================================================

-- Standing volunteer roles / ongoing needs (e.g. "Greeter", "Kitchen team").
create table if not exists public.t3l_volunteer_roles (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  description     text,
  category        text,                       -- Hospitality, Outreach, Admin, ...
  time_commitment text,                        -- free text, e.g. "2 hrs/week"
  active          boolean not null default true,
  sort            int not null default 0,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists t3l_vol_roles_idx on public.t3l_volunteer_roles (active, sort);
alter table public.t3l_volunteer_roles enable row level security;

-- Specific, schedulable opportunities. May be tied to an event and/or a role.
create table if not exists public.t3l_volunteer_opportunities (
  id           uuid primary key default gen_random_uuid(),
  role_id      uuid references public.t3l_volunteer_roles(id) on delete set null,
  event_id     uuid references public.t3l_events(id) on delete set null,
  title        text not null,
  description  text,
  location     text,
  starts_at    timestamptz,                    -- null => flexible / ongoing
  ends_at      timestamptz,
  slots        int,                            -- null => unlimited
  published    boolean not null default true,
  sort         int not null default 0,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists t3l_vol_opps_idx on public.t3l_volunteer_opportunities (published, starts_at);
alter table public.t3l_volunteer_opportunities enable row level security;

-- Member sign-ups for an opportunity.
create table if not exists public.t3l_volunteer_signups (
  id             uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.t3l_volunteer_opportunities(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text,
  email          text,
  status         text not null default 'signed_up'
                   check (status in ('signed_up','confirmed','attended','cancelled','no_show')),
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (opportunity_id, user_id)
);
create index if not exists t3l_vol_signups_opp_idx  on public.t3l_volunteer_signups (opportunity_id);
create index if not exists t3l_vol_signups_user_idx on public.t3l_volunteer_signups (user_id);
alter table public.t3l_volunteer_signups enable row level security;

-- Logged volunteer hours (self-reported, admin-verified). Feeds impact totals.
create table if not exists public.t3l_volunteer_hours (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid references public.t3l_volunteer_opportunities(id) on delete set null,
  name           text,
  hours          numeric(6,2) not null check (hours > 0 and hours <= 1000),
  served_on      date not null default current_date,
  description    text,
  status         text not null default 'pending' check (status in ('pending','verified','rejected')),
  verified_by    uuid references auth.users(id) on delete set null,
  verified_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists t3l_vol_hours_user_idx   on public.t3l_volunteer_hours (user_id);
create index if not exists t3l_vol_hours_status_idx on public.t3l_volunteer_hours (status);
alter table public.t3l_volunteer_hours enable row level security;

-- =========================================================================
-- IMPACT / TRANSPARENCY
-- =========================================================================

-- Curated headline metrics for the public impact page (hand-entered, shown
-- alongside auto-computed stats the edge function derives from live data).
create table if not exists public.t3l_impact_metrics (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,                   -- "People served in 2025"
  value       text not null,                   -- "1,240" (text, so "1,200+" works)
  unit        text,                            -- optional suffix, e.g. "families"
  icon        text,                            -- optional emoji / glyph
  published   boolean not null default true,
  sort        int not null default 0,
  updated_at  timestamptz not null default now()
);
create index if not exists t3l_impact_metrics_idx on public.t3l_impact_metrics (published, sort);
alter table public.t3l_impact_metrics enable row level security;

-- Narrative impact stories (public page + grant evidence).
create table if not exists public.t3l_impact_stories (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  summary     text,
  body        text,
  image_url   text,
  published   boolean not null default true,
  sort        int not null default 0,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists t3l_impact_stories_idx on public.t3l_impact_stories (published, sort);
alter table public.t3l_impact_stories enable row level security;

-- Single-row editable copy for the public impact page (headline + intro).
create table if not exists public.t3l_impact_settings (
  id          int primary key default 1 check (id = 1),
  headline    text not null default 'Our Impact',
  intro       text,
  updated_at  timestamptz not null default now()
);
insert into public.t3l_impact_settings (id, headline, intro) values
  (1, 'Our Impact',
   'Teaching them to love — one life, one family, and one community at a time. Here is a transparent look at the work your support makes possible.')
  on conflict (id) do nothing;
alter table public.t3l_impact_settings enable row level security;

-- =========================================================================
-- MEMBER PRAYER WALL  (extends t3l_prayer_requests from migration 0003)
-- =========================================================================
alter table public.t3l_prayer_requests
  add column if not exists on_wall      boolean not null default false,   -- approved for the member wall
  add column if not exists anonymous    boolean not null default false,   -- hide requester's name on the wall
  add column if not exists answered     boolean not null default false,
  add column if not exists answered_note text;
create index if not exists t3l_prayer_wall_idx on public.t3l_prayer_requests (on_wall, created_at);

-- "I prayed for this" taps (1 per member per request). Drives the wall's count.
create table if not exists public.t3l_prayer_prayed (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.t3l_prayer_requests(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (request_id, user_id)
);
create index if not exists t3l_prayer_prayed_req_idx on public.t3l_prayer_prayed (request_id);
alter table public.t3l_prayer_prayed enable row level security;

-- =========================================================================
-- AUTOMATED EMAIL JOURNEYS  (Resend; fired by pg_cron -> edge function)
-- =========================================================================

-- A journey = one automated email tied to a trigger. Single-step by design.
-- Supported {{tokens}} in subject/body: {{name}}, {{event_title}}, {{event_date}}.
create table if not exists public.t3l_email_journeys (
  id           uuid primary key default gen_random_uuid(),
  key          text unique not null,            -- 'welcome' | 'event_reminder' | 'reengagement'
  name         text not null,
  trigger_type text not null check (trigger_type in ('welcome','event_reminder','reengagement')),
  subject      text not null,
  body         text not null,
  delay_hours  int not null default 0,          -- welcome: hrs after join
  lead_hours   int not null default 48,         -- event_reminder: hrs before event start
  inactive_days int not null default 45,        -- reengagement: no activity for N days
  active       boolean not null default false,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
alter table public.t3l_email_journeys enable row level security;

-- Dedupe ledger: one row per (journey, email, anchor) so cron never re-sends.
create table if not exists public.t3l_email_journey_log (
  id          uuid primary key default gen_random_uuid(),
  journey_key text not null,
  user_id     uuid,
  email       text not null,
  anchor      text not null,                    -- member id / event id / period bucket
  status      text not null default 'sent' check (status in ('sent','failed','skipped')),
  error       text,
  sent_at     timestamptz not null default now(),
  unique (journey_key, email, anchor)
);
create index if not exists t3l_email_journey_log_idx on public.t3l_email_journey_log (journey_key, sent_at);
alter table public.t3l_email_journey_log enable row level security;

-- Seed the three journeys, INACTIVE, with editable starter copy. Nothing sends
-- until an admin reviews the copy and switches a journey on.
insert into public.t3l_email_journeys (key, name, trigger_type, subject, body, delay_hours, lead_hours, inactive_days, active) values
  ('welcome', 'Welcome new members', 'welcome',
   'Welcome to Teach Them to Love',
   E'Hi {{name}},\n\nWelcome to the Teach Them to Love family! We are so glad you are here.\n\nSign in to the member portal any time to join the conversation, explore the Classroom, find a way to serve, and share a prayer request.\n\nWith love,\nTeach Them to Love Outreach Ministries',
   0, 0, 45, false),
  ('event_reminder', 'Upcoming event reminder', 'event_reminder',
   'Coming up: {{event_title}}',
   E'Hi {{name}},\n\nThis is a friendly reminder that {{event_title}} is coming up on {{event_date}}.\n\nWe would love to see you there!\n\nTeach Them to Love Outreach Ministries',
   0, 48, 45, false),
  ('reengagement', 'We miss you', 'reengagement',
   'We would love to see you back',
   E'Hi {{name}},\n\nIt has been a little while since we have seen you in the member portal, and we have missed you.\n\nThere is always something new happening — stop by whenever you are ready.\n\nWith love,\nTeach Them to Love Outreach Ministries',
   0, 0, 45, false)
on conflict (key) do nothing;
