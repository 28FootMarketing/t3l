-- Community: Skool-style gamification + classroom (project neptxzpueslyzfgaktez).
-- Service-role only (the t3l-portal edge function mediates all access).
--
-- Points model (Skool classic): a member earns 1 point for every like their
-- posts receive. Levels are cumulative point thresholds. Leaderboards rank by
-- points earned in a time window (7-day / 30-day / all-time).
-- Classroom: courses -> lessons, each course unlockable at a member level.

-- --- Likes on community posts (1 like = 1 point to the post's author) ---
create table if not exists public.t3l_community_likes (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.t3l_community_posts(id) on delete cascade,
  user_id    uuid not null,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);
create index if not exists t3l_comm_likes_post_idx on public.t3l_community_likes (post_id);
create index if not exists t3l_comm_likes_when_idx on public.t3l_community_likes (created_at);
alter table public.t3l_community_likes enable row level security;

-- --- Levels (cumulative point thresholds; editable by admins) ---
create table if not exists public.t3l_community_levels (
  level      int primary key,
  min_points int not null,
  name       text not null
);
alter table public.t3l_community_levels enable row level security;

insert into public.t3l_community_levels (level, min_points, name) values
  (1, 0,     'Seed'),
  (2, 5,     'Sprout'),
  (3, 20,    'Rooted'),
  (4, 65,    'Growing'),
  (5, 155,   'Blooming'),
  (6, 515,   'Fruitful'),
  (7, 2015,  'Flourishing'),
  (8, 8015,  'Thriving'),
  (9, 33015, 'Cornerstone')
on conflict (level) do nothing;

-- --- Classroom: courses + lessons + per-member progress ---
create table if not exists public.t3l_community_courses (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  cover_url    text,
  unlock_level int not null default 1,   -- members at/above this level can open it
  published    boolean not null default true,
  sort         int not null default 0,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists t3l_comm_courses_idx on public.t3l_community_courses (published, sort);
alter table public.t3l_community_courses enable row level security;

create table if not exists public.t3l_community_lessons (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.t3l_community_courses(id) on delete cascade,
  section    text,                        -- optional grouping within a course
  title      text not null,
  content    text,
  video_url  text,
  published  boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists t3l_comm_lessons_course_idx on public.t3l_community_lessons (course_id, sort);
alter table public.t3l_community_lessons enable row level security;

create table if not exists public.t3l_community_lesson_progress (
  id           uuid primary key default gen_random_uuid(),
  lesson_id    uuid not null references public.t3l_community_lessons(id) on delete cascade,
  user_id      uuid not null,
  completed    boolean not null default true,
  completed_at timestamptz not null default now(),
  unique (lesson_id, user_id)
);
create index if not exists t3l_comm_lp_user_idx on public.t3l_community_lesson_progress (user_id);
alter table public.t3l_community_lesson_progress enable row level security;

-- --- Leaderboard: points = likes received on a member's posts, windowed ---
create or replace function public.t3l_community_leaderboard(p_since timestamptz default null)
returns table(user_id uuid, display_name text, points bigint)
language sql stable security definer as $$
  select p.author_user_id as user_id,
         coalesce(max(prof.display_name), max(p.author_name), 'Member') as display_name,
         count(l.id) as points
  from public.t3l_community_likes l
  join public.t3l_community_posts p on p.id = l.post_id
  left join public.t3l_community_profiles prof on prof.user_id = p.author_user_id
  where (p_since is null or l.created_at >= p_since)
    and p.author_user_id is not null
  group by p.author_user_id
  order by points desc, display_name asc
  limit 100;
$$;
