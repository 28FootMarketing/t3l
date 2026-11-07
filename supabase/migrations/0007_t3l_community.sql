-- Community module (project neptxzpueslyzfgaktez). Service-role only (the
-- t3l-portal edge function mediates all access; the member JWT is verified
-- server-side). Member-facing features inside the client portal:
--   * Community feed  (t3l_community_posts)
--   * Small groups    (t3l_community_groups + t3l_community_group_members)
--   * Member directory (t3l_community_profiles, opt-in only)

create table if not exists public.t3l_community_posts (
  id             uuid primary key default gen_random_uuid(),
  author_user_id uuid references auth.users(id) on delete set null,
  author_name    text not null default 'Member',
  body           text not null,
  pinned         boolean not null default false,
  hidden         boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists t3l_community_posts_feed_idx
  on public.t3l_community_posts (hidden, pinned desc, created_at desc);

create table if not exists public.t3l_community_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  meeting_time text,
  location    text,
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
insert into public.t3l_community_groups (name, description, meeting_time, sort)
select v.name, v.description, v.meeting_time, v.sort from (values
  ('Sunday Small Group','A weekly gathering for study, prayer, and fellowship.','Sundays · 9:00 AM',10),
  ('Men''s Fellowship','Encouragement and accountability for the men of the community.','2nd & 4th Saturdays · 8:00 AM',20),
  ('Women''s Circle','Connection, support, and growth for the women of the community.','Wednesdays · 6:30 PM',30),
  ('Youth & Young Adults','For students and young adults finding their way one step at a time.','Fridays · 7:00 PM',40)
) as v(name,description,meeting_time,sort)
where not exists (select 1 from public.t3l_community_groups);

create table if not exists public.t3l_community_group_members (
  group_id   uuid not null references public.t3l_community_groups(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  member_name text,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists t3l_community_group_members_user_idx
  on public.t3l_community_group_members (user_id);

-- Opt-in member directory. Nothing is shown unless show_in_directory is true.
create table if not exists public.t3l_community_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  display_name      text,
  about             text,
  show_in_directory boolean not null default false,
  updated_at        timestamptz not null default now()
);

alter table public.t3l_community_posts         enable row level security;
alter table public.t3l_community_groups        enable row level security;
alter table public.t3l_community_group_members enable row level security;
alter table public.t3l_community_profiles      enable row level security;
