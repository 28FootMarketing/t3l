// ============================================================================
// t3l-portal — T3L portal auth gate + member management + admin console host
// ----------------------------------------------------------------------------
// Supabase project neptxzpueslyzfgaktez. Deploy with verify_jwt = false: this
// function verifies the caller's JWT itself so it can also serve the public
// `status`/`bootstrap` actions. All privileged work uses the service role,
// which stays inside this function and never reaches the browser.
//
// Role tiers: super_admin > admin > client
//
// The admin console markup lives in public.t3l_portal_assets['admin_app'] and
// is returned (action "app") ONLY to a verified admin/super session. It is
// seeded via POST ?action=seed_app with the HTML as the raw body (allowed when
// no console is stored yet, or to a super admin thereafter).
//
// Actions (POST JSON { action, ... } unless noted):
//   status        -> { setup_needed }                         (public)
//   bootstrap     -> creates the first SUPER admin            (public, one-time)
//   me            -> { member|null }                          (any signed-in user)
//   app           -> { html }  admin console                  (admin/super; 403 otherwise)
//   invite        -> create member + send link                (admin/super; admins: clients only)
//   list_members  -> { members }                              (admin/super)
//   set_role      -> change a member's role                   (super only)
//   revoke        -> revoke a member                          (admin: clients; super: anyone)
//   get_config    -> { config }  webhook URLs                 (admin/super)
//   set_config    -> save webhook URLs                        (admin/super)
//   ?action=seed_app (raw body) -> store the admin console    (first write, or super)
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FIRST_ADMIN_EMAIL = (Deno.env.get("T3L_FIRST_ADMIN_EMAIL") || "").toLowerCase().trim();
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

type Role = "client" | "admin" | "super_admin";

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" } as Record<string, string>)[c]);
}

const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>Admin</title>
<body style="font-family:system-ui;background:#2a123f;color:#fff;display:grid;place-items:center;min-height:100vh;text-align:center;margin:0">
<div style="max-width:40ch;padding:24px"><h1 style="font-family:Georgia,serif">Console not provisioned</h1>
<p>The administrator console has not been loaded yet. Please contact your developer.</p></div></body>`;

function corsHeaders(origin: string | null): Record<string, string> {
  let allow = "https://t3loutreach.org";
  if (origin && (
    origin === "https://t3loutreach.org" ||
    origin === "https://www.t3loutreach.org" ||
    origin.endsWith(".vercel.app") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1")
  )) allow = origin;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function svc() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function activeSuperCount(sb: any): Promise<number> {
  const { count } = await sb.from("t3l_portal_members")
    .select("user_id", { count: "exact", head: true })
    .eq("role", "super_admin").eq("status", "active");
  return count || 0;
}

async function getMember(sb: any, uid: string): Promise<any | null> {
  const { data } = await sb.from("t3l_portal_members")
    .select("user_id,email,role,full_name,status").eq("user_id", uid).maybeSingle();
  return data || null;
}

async function getCaller(sb: any, req: Request): Promise<{ user: any; member: any } | null> {
  const authz = req.headers.get("Authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return { user: data.user, member: await getMember(sb, data.user.id) };
}

async function findUserByEmail(sb: any, email: string): Promise<any | null> {
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) break;
    const hit = data.users.find((u: any) => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function inviteMember(sb: any, email: string, role: Role, invitedBy: string | null, redirectTo?: string): Promise<{ member?: any; error?: string }> {
  let userId: string | null = null;
  const opts: Record<string, unknown> = {};
  if (redirectTo) opts.redirectTo = redirectTo;
  const inv = await sb.auth.admin.inviteUserByEmail(email, opts);
  if (inv.error) {
    const found = await findUserByEmail(sb, email);
    if (!found) return { error: inv.error.message };
    userId = found.id;
  } else {
    userId = inv.data?.user?.id ?? null;
  }
  if (!userId) return { error: "Could not resolve the invited user." };
  const row = { user_id: userId, email, role, status: "active", invited_by: invitedBy, updated_at: new Date().toISOString() };
  const up = await sb.from("t3l_portal_members").upsert(row, { onConflict: "user_id" }).select().maybeSingle();
  if (up.error) return { error: up.error.message };
  return { member: up.data };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const sb = svc();

  try {
    // --- seed_app: raw body upload of an admin console markup ---
    // ?key=admin_app (regular-admin view, default) | admin_app_super (super-admin view)
    const url0 = new URL(req.url);
    const qsAction = url0.searchParams.get("action");
    if (qsAction === "seed_app") {
      const key = url0.searchParams.get("key") === "admin_app_super" ? "admin_app_super" : "admin_app";
      const existing = await sb.from("t3l_portal_assets").select("key").eq("key", key).maybeSingle();
      if (existing.data) {
        const caller = await getCaller(sb, req);
        const ok = caller?.member && caller.member.role === "super_admin" && caller.member.status === "active";
        if (!ok) return json({ error: "A console is already stored; only a super administrator can replace it." }, 403);
      }
      const body = await req.text();
      if (!body || body.length < 200) return json({ error: "Body too small to be the console." }, 400);
      const { error } = await sb.from("t3l_portal_assets")
        .upsert({ key, content: body, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, key, bytes: body.length });
    }

    let payload: any = {};
    try { payload = await req.json(); } catch { payload = {}; }
    const action = String(payload.action || "");

    if (action === "status") return json({ setup_needed: (await activeSuperCount(sb)) === 0 });

    // --- Public: impact / transparency feed (no auth) ---
    // Only aggregate counts + admin-curated PUBLISHED content. Never any PII.
    if (action === "impact_public") {
      const today = new Date().toISOString().slice(0, 10);
      const [settings, metrics, stories, members, eventsHosted, lessons, posts, hoursRows, prayers] = await Promise.all([
        sb.from("t3l_impact_settings").select("headline,intro").eq("id", 1).maybeSingle(),
        sb.from("t3l_impact_metrics").select("label,value,unit,icon,sort").eq("published", true).order("sort", { ascending: true }),
        sb.from("t3l_impact_stories").select("title,summary,body,image_url,sort,created_at").eq("published", true).order("sort", { ascending: true }).limit(24),
        sb.from("t3l_portal_members").select("user_id", { count: "exact", head: true }).eq("status", "active"),
        sb.from("t3l_events").select("id", { count: "exact", head: true }).eq("published", true).lt("start_date", today),
        sb.from("t3l_community_lessons").select("id", { count: "exact", head: true }).eq("published", true),
        sb.from("t3l_community_posts").select("id", { count: "exact", head: true }).eq("hidden", false),
        sb.from("t3l_volunteer_hours").select("hours").eq("status", "verified"),
        sb.from("t3l_prayer_prayed").select("id", { count: "exact", head: true }),
      ]);
      let volunteerHours = 0;
      (hoursRows.data || []).forEach((r: any) => { volunteerHours += Number(r.hours) || 0; });
      return json({
        settings: settings.data || { headline: "Our Impact", intro: "" },
        metrics: metrics.data || [],
        stories: stories.data || [],
        auto: {
          community_members: members.count || 0,
          events_hosted: eventsHosted.count || 0,
          classroom_lessons: lessons.count || 0,
          community_posts: posts.count || 0,
          volunteer_hours: Math.round(volunteerHours),
          prayers_covered: prayers.count || 0,
        },
      });
    }

    // --- Cron: automated email journeys (pg_cron -> this endpoint) ---
    // Guarded by a shared secret; never requires a user session. Ships inert:
    // every journey is inactive until an admin switches it on, and each send is
    // deduped by the unique (journey_key,email,anchor) ledger row.
    if (action === "cron_email_journeys") {
      const secret = String(payload.secret || req.headers.get("x-cron-secret") || "");
      const { data: cs } = await sb.from("t3l_portal_config").select("value").eq("key", "cron_secret").maybeSingle();
      const expected = (cs && cs.value) || "";
      if (!expected || secret !== expected) return json({ error: "forbidden" }, 403);
      if (!RESEND_API_KEY) return json({ ok: true, skipped: "RESEND_API_KEY not set" });

      const { data: cfg } = await sb.from("t3l_portal_config").select("value").eq("key", "comms_from_email").maybeSingle();
      const from = (cfg && cfg.value) || "Teach Them to Love <outreach@mail.28footsystems.com>";
      const { data: journeys } = await sb.from("t3l_email_journeys").select("*").eq("active", true);
      const active = journeys || [];
      const now = Date.now();
      const results: Record<string, number> = {};
      const render = (s: string, vars: Record<string, string>) =>
        String(s || "").replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => (vars[k] != null ? vars[k] : ""));
      const nameFromMember = (m: any) => (m.full_name || (m.email ? String(m.email).split("@")[0] : "friend"));

      // Claim + send one email; dedupe via the unique (journey_key,email,anchor).
      const deliver = async (jkey: string, uid: string | null, email: string, anchor: string, subject: string, text: string): Promise<boolean> => {
        const claim = await sb.from("t3l_email_journey_log")
          .insert({ journey_key: jkey, user_id: uid, email, anchor, status: "sent" }).select("id").maybeSingle();
        if (claim.error) return false; // already claimed (unique violation) => skip
        const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#2b2030;line-height:1.6;white-space:pre-wrap">' + escapeHtml(text) + '</div>';
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ from, to: [email], subject, html, text }),
          });
          if (!res.ok) {
            let e = "HTTP " + res.status; try { const j = await res.json(); e = (j && (j.message || JSON.stringify(j))) || e; } catch (_x) { /* noop */ }
            await sb.from("t3l_email_journey_log").update({ status: "failed", error: e }).eq("journey_key", jkey).eq("email", email).eq("anchor", anchor);
            return false;
          }
          return true;
        } catch (e) {
          await sb.from("t3l_email_journey_log").update({ status: "failed", error: String((e as Error).message || e) }).eq("journey_key", jkey).eq("email", email).eq("anchor", anchor);
          return false;
        }
      };

      let budget = 300; // safety cap per run
      for (const j of active) {
        let sent = 0;
        if (j.trigger_type === "welcome") {
          const lo = new Date(now - (j.delay_hours + 96) * 3600 * 1000).toISOString(); // 4-day catch-up window
          const hi = new Date(now - j.delay_hours * 3600 * 1000).toISOString();
          const { data: mem } = await sb.from("t3l_portal_members")
            .select("user_id,email,full_name,created_at").eq("status", "active")
            .gte("created_at", lo).lte("created_at", hi).limit(200);
          for (const m of (mem || [])) {
            if (budget <= 0) break; if (!m.email) continue;
            const vars = { name: nameFromMember(m) };
            if (await deliver(j.key, m.user_id, m.email, "member:" + m.user_id, render(j.subject, vars), render(j.body, vars))) { sent++; budget--; }
          }
        } else if (j.trigger_type === "event_reminder") {
          const today = new Date().toISOString().slice(0, 10);
          const horizon = new Date(now + (j.lead_hours || 48) * 3600 * 1000).toISOString().slice(0, 10);
          const { data: evs } = await sb.from("t3l_events").select("id,title,start_date,start_time")
            .eq("published", true).gte("start_date", today).lte("start_date", horizon)
            .order("start_date", { ascending: true }).limit(20);
          if ((evs || []).length) {
            const { data: mem } = await sb.from("t3l_portal_members").select("user_id,email,full_name").eq("status", "active").limit(1000);
            for (const ev of (evs || [])) {
              const dateLabel = ev.start_date + (ev.start_time ? (" at " + ev.start_time) : "");
              for (const m of (mem || [])) {
                if (budget <= 0) break; if (!m.email) continue;
                const vars = { name: nameFromMember(m), event_title: ev.title || "an upcoming event", event_date: dateLabel };
                if (await deliver(j.key, m.user_id, m.email, "event:" + ev.id, render(j.subject, vars), render(j.body, vars))) { sent++; budget--; }
              }
            }
          }
        } else if (j.trigger_type === "reengagement") {
          const cutoffIso = new Date(now - (j.inactive_days || 45) * 86400 * 1000).toISOString();
          const bucket = new Date().toISOString().slice(0, 7); // at most once per member per month
          const { data: mem } = await sb.from("t3l_portal_members")
            .select("user_id,email,full_name,created_at").eq("status", "active")
            .lte("created_at", cutoffIso).limit(500);
          for (const m of (mem || [])) {
            if (budget <= 0) break; if (!m.email) continue;
            const [p, l, lp, su] = await Promise.all([
              sb.from("t3l_community_posts").select("id", { count: "exact", head: true }).eq("author_user_id", m.user_id).gte("created_at", cutoffIso),
              sb.from("t3l_community_likes").select("id", { count: "exact", head: true }).eq("user_id", m.user_id).gte("created_at", cutoffIso),
              sb.from("t3l_community_lesson_progress").select("id", { count: "exact", head: true }).eq("user_id", m.user_id).gte("completed_at", cutoffIso),
              sb.from("t3l_volunteer_signups").select("id", { count: "exact", head: true }).eq("user_id", m.user_id).gte("created_at", cutoffIso),
            ]);
            if ((p.count || 0) + (l.count || 0) + (lp.count || 0) + (su.count || 0) > 0) continue; // still active
            const vars = { name: nameFromMember(m) };
            if (await deliver(j.key, m.user_id, m.email, "reengage:" + bucket, render(j.subject, vars), render(j.body, vars))) { sent++; budget--; }
          }
        }
        results[j.key] = sent;
      }
      return json({ ok: true, sent: results });
    }

    if (action === "bootstrap") {
      if (!FIRST_ADMIN_EMAIL) return json({ error: "Administrator email is not configured on the server." }, 400);
      if ((await activeSuperCount(sb)) > 0) return json({ error: "Administrator setup is already complete." }, 409);
      const res = await inviteMember(sb, FIRST_ADMIN_EMAIL, "super_admin", null, payload.redirectTo);
      if (res.error) return json({ error: res.error }, 400);
      return json({ ok: true });
    }

    const caller = await getCaller(sb, req);
    const callerRole: Role | null = caller?.member?.status === "active" ? (caller.member.role as Role) : null;
    const isAdmin = callerRole === "admin" || callerRole === "super_admin";
    const isSuper = callerRole === "super_admin";

    if (action === "me") return json({ member: caller?.member ?? null });

    if (action === "prayer_request") {
      if (!caller) return json({ error: "unauthorized" }, 401);
      if (!caller.member || caller.member.status !== "active") return json({ error: "forbidden" }, 403);
      const request = String(payload.request || "").trim();
      if (request.length < 2) return json({ error: "Please enter your prayer request." }, 400);
      const row = {
        user_id: caller.user.id,
        name: String(payload.name || "").trim() || null,
        email: String(payload.email || "").trim() || null,
        ministry_role: String(payload.ministry_role || "").trim() || null,
        request,
        updated_at: new Date().toISOString(),
      };
      const ins = await sb.from("t3l_prayer_requests").insert(row).select().maybeSingle();
      if (ins.error) return json({ error: ins.error.message }, 400);
      try {
        const { data: cfg } = await sb.from("t3l_portal_config").select("value").eq("key", "admin_webhook_url").maybeSingle();
        const hook = cfg && cfg.value;
        if (hook) await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "prayer.request", data: row, submittedAt: new Date().toISOString(), source: "Teach Them to Love Client Portal" }) });
      } catch (_e) { /* best-effort forward to GoHighLevel */ }
      return json({ ok: true });
    }

    // --- Community module (any ACTIVE member: client/admin/super) ---
    if (action.startsWith("community_")) {
      if (!caller) return json({ error: "unauthorized" }, 401);
      if (!caller.member || caller.member.status !== "active") return json({ error: "forbidden" }, 403);
      const uid = caller.user.id;
      const memberName = (caller.member.full_name || caller.member.email || "Member");

      // --- Skool-style gamification helpers (points = likes received on your posts) ---
      const pointsFor = async (who: string): Promise<number> => {
        const { data: myPosts } = await sb.from("t3l_community_posts").select("id").eq("author_user_id", who);
        const ids = (myPosts || []).map((p: any) => p.id);
        if (!ids.length) return 0;
        const { count } = await sb.from("t3l_community_likes").select("id", { count: "exact", head: true }).in("post_id", ids);
        return count || 0;
      };
      const getLevels = async (): Promise<any[]> => {
        const { data } = await sb.from("t3l_community_levels").select("level,min_points,name").order("level", { ascending: true });
        return data && data.length ? data : [{ level: 1, min_points: 0, name: "Level 1" }];
      };
      const levelFor = (points: number, levels: any[]) => {
        let cur = levels[0]; for (const L of levels) { if (points >= L.min_points) cur = L; }
        const next = levels.find((L: any) => L.min_points > points) || null;
        return { level: cur, next };
      };

      if (action === "community_feed") {
        const { data } = await sb.from("t3l_community_posts")
          .select("id,author_user_id,author_name,body,pinned,created_at")
          .eq("hidden", false).order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(60);
        const list = data || [];
        const ids = list.map((p: any) => p.id);
        const counts: Record<string, number> = {}; const mineLiked: Record<string, boolean> = {};
        if (ids.length) {
          const { data: likes } = await sb.from("t3l_community_likes").select("post_id,user_id").in("post_id", ids);
          (likes || []).forEach((l: any) => { counts[l.post_id] = (counts[l.post_id] || 0) + 1; if (l.user_id === uid) mineLiked[l.post_id] = true; });
        }
        const posts = list.map((p: any) => ({
          id: p.id, author_name: p.author_name, body: p.body, pinned: p.pinned,
          created_at: p.created_at, mine: p.author_user_id === uid,
          likes: counts[p.id] || 0, liked: !!mineLiked[p.id],
        }));
        return json({ posts });
      }

      // Like / unlike a post (1 like = 1 point to the post's author).
      if (action === "community_post_like") {
        const post_id = String(payload.post_id || ""); if (!post_id) return json({ error: "post_id is required." }, 400);
        const like = payload.like !== false;
        if (like) {
          await sb.from("t3l_community_likes").upsert({ post_id, user_id: uid }, { onConflict: "post_id,user_id" });
        } else {
          await sb.from("t3l_community_likes").delete().eq("post_id", post_id).eq("user_id", uid);
        }
        const { count } = await sb.from("t3l_community_likes").select("id", { count: "exact", head: true }).eq("post_id", post_id);
        return json({ ok: true, likes: count || 0, liked: like });
      }

      // My gamification stats: points, level, progress to next, lessons completed.
      if (action === "community_me") {
        const points = await pointsFor(uid);
        const levels = await getLevels();
        const { level, next } = levelFor(points, levels);
        const { count: done } = await sb.from("t3l_community_lesson_progress")
          .select("id", { count: "exact", head: true }).eq("user_id", uid).eq("completed", true);
        return json({ points, level: level.level, level_name: level.name,
          next_level: next ? next.level : null, next_name: next ? next.name : null,
          next_points: next ? next.min_points : null, lessons_completed: done || 0 });
      }

      if (action === "community_levels") {
        return json({ levels: await getLevels() });
      }

      // Leaderboard: points earned in a window (7-day / 30-day / all-time).
      if (action === "community_leaderboard") {
        const range = String(payload.range || "all");
        let since: string | null = null;
        if (range === "7d") since = new Date(Date.now() - 7 * 864e5).toISOString();
        else if (range === "30d") since = new Date(Date.now() - 30 * 864e5).toISOString();
        const { data, error } = await sb.rpc("t3l_community_leaderboard", { p_since: since });
        if (error) return json({ error: error.message }, 400);
        const levels = await getLevels();
        const rows = (data || []).map((r: any, i: number) => {
          const lv = levelFor(Number(r.points) || 0, levels).level;
          return { rank: i + 1, user_id: r.user_id, display_name: r.display_name, points: Number(r.points) || 0,
            level: lv.level, level_name: lv.name, mine: r.user_id === uid };
        });
        return json({ range, rows });
      }

      // Classroom: list courses with my lock state + progress.
      if (action === "community_courses") {
        const points = await pointsFor(uid);
        const levels = await getLevels();
        const myLevel = levelFor(points, levels).level.level;
        const { data: courses } = await sb.from("t3l_community_courses")
          .select("id,title,description,cover_url,unlock_level,sort").eq("published", true).order("sort", { ascending: true });
        const cids = (courses || []).map((c: any) => c.id);
        const lessonCount: Record<string, number> = {}; const lessonIds: Record<string, string[]> = {};
        if (cids.length) {
          const { data: lessons } = await sb.from("t3l_community_lessons").select("id,course_id").eq("published", true).in("course_id", cids);
          (lessons || []).forEach((l: any) => { lessonCount[l.course_id] = (lessonCount[l.course_id] || 0) + 1; (lessonIds[l.course_id] = lessonIds[l.course_id] || []).push(l.id); });
        }
        const { data: prog } = await sb.from("t3l_community_lesson_progress").select("lesson_id").eq("user_id", uid).eq("completed", true);
        const doneSet: Record<string, boolean> = {}; (prog || []).forEach((p: any) => { doneSet[p.lesson_id] = true; });
        const out = (courses || []).map((c: any) => {
          const total = lessonCount[c.id] || 0;
          const done = (lessonIds[c.id] || []).filter((id: string) => doneSet[id]).length;
          return { id: c.id, title: c.title, description: c.description, cover_url: c.cover_url,
            unlock_level: c.unlock_level, locked: myLevel < c.unlock_level, lessons: total, completed: done };
        });
        return json({ courses: out, my_level: myLevel });
      }

      // Classroom: one course with its lessons + my completion (respects level lock).
      if (action === "community_course") {
        const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
        const { data: course } = await sb.from("t3l_community_courses").select("id,title,description,cover_url,unlock_level,published").eq("id", id).maybeSingle();
        if (!course || !course.published) return json({ error: "That course was not found." }, 404);
        const points = await pointsFor(uid);
        const levels = await getLevels();
        const myLevel = levelFor(points, levels).level.level;
        if (myLevel < course.unlock_level) {
          return json({ course: { id: course.id, title: course.title, description: course.description, unlock_level: course.unlock_level }, locked: true, my_level: myLevel });
        }
        const { data: lessons } = await sb.from("t3l_community_lessons")
          .select("id,section,title,content,video_url,sort").eq("course_id", id).eq("published", true).order("sort", { ascending: true });
        const { data: prog } = await sb.from("t3l_community_lesson_progress").select("lesson_id").eq("user_id", uid).eq("completed", true);
        const doneSet: Record<string, boolean> = {}; (prog || []).forEach((p: any) => { doneSet[p.lesson_id] = true; });
        const out = (lessons || []).map((l: any) => ({ ...l, completed: !!doneSet[l.id] }));
        return json({ course: { id: course.id, title: course.title, description: course.description, cover_url: course.cover_url, unlock_level: course.unlock_level }, locked: false, lessons: out });
      }

      // Classroom: mark a lesson complete / incomplete.
      if (action === "community_lesson_complete") {
        const lesson_id = String(payload.lesson_id || ""); if (!lesson_id) return json({ error: "lesson_id is required." }, 400);
        const done = payload.completed !== false;
        if (done) {
          await sb.from("t3l_community_lesson_progress").upsert({ lesson_id, user_id: uid, completed: true, completed_at: new Date().toISOString() }, { onConflict: "lesson_id,user_id" });
        } else {
          await sb.from("t3l_community_lesson_progress").delete().eq("lesson_id", lesson_id).eq("user_id", uid);
        }
        return json({ ok: true, completed: done });
      }

      // --- Admin authoring: courses + lessons ---
      if (action === "community_courses_admin") {
        if (!isAdmin) return json({ error: "Only an administrator can manage the classroom." }, 403);
        const { data: courses } = await sb.from("t3l_community_courses")
          .select("id,title,description,cover_url,unlock_level,published,sort").order("sort", { ascending: true });
        const cids = (courses || []).map((c: any) => c.id);
        const counts: Record<string, number> = {};
        if (cids.length) {
          const { data: lessons } = await sb.from("t3l_community_lessons").select("id,course_id").in("course_id", cids);
          (lessons || []).forEach((l: any) => { counts[l.course_id] = (counts[l.course_id] || 0) + 1; });
        }
        return json({ courses: (courses || []).map((c: any) => ({ ...c, lessons: counts[c.id] || 0 })) });
      }

      if (action === "community_course_save") {
        if (!isAdmin) return json({ error: "Only an administrator can manage the classroom." }, 403);
        const title = String(payload.title || "").trim(); if (!title) return json({ error: "Course title is required." }, 400);
        const row: Record<string, unknown> = {
          title, description: String(payload.description || "").trim() || null,
          cover_url: String(payload.cover_url || "").trim() || null,
          unlock_level: Math.max(1, Number(payload.unlock_level) || 1),
          published: payload.published === false ? false : true,
          sort: Number(payload.sort) || 0, updated_at: new Date().toISOString(),
        };
        const id = String(payload.id || "");
        if (id) { const { error } = await sb.from("t3l_community_courses").update(row).eq("id", id); if (error) return json({ error: error.message }, 400); return json({ ok: true }); }
        const { data, error } = await sb.from("t3l_community_courses").insert({ ...row, created_by: uid }).select().maybeSingle();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, course: data });
      }

      if (action === "community_course_delete") {
        if (!isAdmin) return json({ error: "Only an administrator can manage the classroom." }, 403);
        const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
        const { error } = await sb.from("t3l_community_courses").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      if (action === "community_lessons_admin") {
        if (!isAdmin) return json({ error: "Only an administrator can manage the classroom." }, 403);
        const course_id = String(payload.course_id || ""); if (!course_id) return json({ error: "course_id is required." }, 400);
        const { data } = await sb.from("t3l_community_lessons")
          .select("id,section,title,content,video_url,published,sort").eq("course_id", course_id).order("sort", { ascending: true });
        return json({ lessons: data || [] });
      }

      if (action === "community_lesson_save") {
        if (!isAdmin) return json({ error: "Only an administrator can manage the classroom." }, 403);
        const course_id = String(payload.course_id || ""); if (!course_id) return json({ error: "course_id is required." }, 400);
        const title = String(payload.title || "").trim(); if (!title) return json({ error: "Lesson title is required." }, 400);
        const row: Record<string, unknown> = {
          course_id, title, section: String(payload.section || "").trim() || null,
          content: String(payload.content || "").trim() || null, video_url: String(payload.video_url || "").trim() || null,
          published: payload.published === false ? false : true, sort: Number(payload.sort) || 0, updated_at: new Date().toISOString(),
        };
        const id = String(payload.id || "");
        if (id) { const { error } = await sb.from("t3l_community_lessons").update(row).eq("id", id); if (error) return json({ error: error.message }, 400); return json({ ok: true }); }
        const { data, error } = await sb.from("t3l_community_lessons").insert(row).select().maybeSingle();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, lesson: data });
      }

      if (action === "community_lesson_delete") {
        if (!isAdmin) return json({ error: "Only an administrator can manage the classroom." }, 403);
        const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
        const { error } = await sb.from("t3l_community_lessons").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      if (action === "community_post") {
        const body = String(payload.body || "").trim();
        if (body.length < 2) return json({ error: "Write a message to share." }, 400);
        if (body.length > 5000) return json({ error: "That message is too long." }, 400);
        const { data, error } = await sb.from("t3l_community_posts")
          .insert({ author_user_id: uid, author_name: memberName, body }).select().maybeSingle();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, post: data });
      }

      if (action === "community_post_delete") {
        const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
        const { data: post } = await sb.from("t3l_community_posts").select("author_user_id").eq("id", id).maybeSingle();
        if (!post) return json({ error: "That post was not found." }, 404);
        if (post.author_user_id !== uid && !isAdmin) return json({ error: "You can only remove your own posts." }, 403);
        const { error } = await sb.from("t3l_community_posts").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      if (action === "community_groups") {
        const { data: groups } = await sb.from("t3l_community_groups")
          .select("id,name,description,meeting_time,location,sort").eq("active", true).order("sort", { ascending: true });
        const { data: mine } = await sb.from("t3l_community_group_members").select("group_id").eq("user_id", uid);
        const { data: all } = await sb.from("t3l_community_group_members").select("group_id");
        const joined: Record<string, boolean> = {}; (mine || []).forEach((m: any) => { joined[m.group_id] = true; });
        const counts: Record<string, number> = {}; (all || []).forEach((m: any) => { counts[m.group_id] = (counts[m.group_id] || 0) + 1; });
        const out = (groups || []).map((g: any) => ({
          id: g.id, name: g.name, description: g.description, meeting_time: g.meeting_time, location: g.location,
          member_count: counts[g.id] || 0, joined: !!joined[g.id],
        }));
        return json({ groups: out });
      }

      if (action === "community_group_join") {
        const group_id = String(payload.group_id || ""); if (!group_id) return json({ error: "group_id is required." }, 400);
        const { error } = await sb.from("t3l_community_group_members")
          .upsert({ group_id, user_id: uid, member_name: memberName }, { onConflict: "group_id,user_id" });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      if (action === "community_group_leave") {
        const group_id = String(payload.group_id || ""); if (!group_id) return json({ error: "group_id is required." }, 400);
        const { error } = await sb.from("t3l_community_group_members").delete().eq("group_id", group_id).eq("user_id", uid);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // Admin-only: create / edit a group.
      if (action === "community_group_save") {
        if (!isAdmin) return json({ error: "Only an administrator can manage groups." }, 403);
        const name = String(payload.name || "").trim(); if (!name) return json({ error: "Group name is required." }, 400);
        const rowg = {
          name, description: String(payload.description || "") || null,
          meeting_time: String(payload.meeting_time || "") || null, location: String(payload.location || "") || null,
          active: payload.active === false ? false : true, sort: Number(payload.sort) || 0,
        };
        const id = String(payload.id || "");
        const res = id
          ? await sb.from("t3l_community_groups").update(rowg).eq("id", id)
          : await sb.from("t3l_community_groups").insert(rowg);
        if (res.error) return json({ error: res.error.message }, 400);
        return json({ ok: true });
      }

      // Admin-only: full group list (incl. inactive) with member counts.
      if (action === "community_admin_groups") {
        if (!isAdmin) return json({ error: "Only an administrator can manage the community." }, 403);
        const { data: groups } = await sb.from("t3l_community_groups")
          .select("id,name,description,meeting_time,location,active,sort").order("sort", { ascending: true });
        const { data: all } = await sb.from("t3l_community_group_members").select("group_id");
        const counts: Record<string, number> = {}; (all || []).forEach((m: any) => { counts[m.group_id] = (counts[m.group_id] || 0) + 1; });
        return json({ groups: (groups || []).map((g: any) => ({ ...g, member_count: counts[g.id] || 0 })) });
      }

      // Admin-only: full feed (incl. hidden) for moderation.
      if (action === "community_admin_feed") {
        if (!isAdmin) return json({ error: "Only an administrator can moderate the feed." }, 403);
        const { data } = await sb.from("t3l_community_posts")
          .select("id,author_name,body,pinned,hidden,created_at").order("created_at", { ascending: false }).limit(200);
        return json({ posts: data || [] });
      }

      // Admin-only: pin / unpin a post.
      if (action === "community_post_pin") {
        if (!isAdmin) return json({ error: "Only an administrator can pin posts." }, 403);
        const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
        const { error } = await sb.from("t3l_community_posts").update({ pinned: !!payload.pinned }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // Admin-only: hide / unhide a post (soft moderation; keeps the record).
      if (action === "community_post_hide") {
        if (!isAdmin) return json({ error: "Only an administrator can hide posts." }, 403);
        const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
        const { error } = await sb.from("t3l_community_posts").update({ hidden: !!payload.hidden }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      if (action === "community_directory") {
        const { data } = await sb.from("t3l_community_profiles")
          .select("display_name,about").eq("show_in_directory", true).order("display_name", { ascending: true }).limit(500);
        return json({ profiles: data || [] });
      }

      if (action === "community_profile_get") {
        const { data } = await sb.from("t3l_community_profiles").select("display_name,about,show_in_directory").eq("user_id", uid).maybeSingle();
        return json({ profile: data || { display_name: memberName, about: "", show_in_directory: false } });
      }

      if (action === "community_profile_save") {
        const row = {
          user_id: uid,
          display_name: String(payload.display_name || "").trim() || memberName,
          about: String(payload.about || "").trim() || null,
          show_in_directory: !!payload.show_in_directory,
          updated_at: new Date().toISOString(),
        };
        const { error } = await sb.from("t3l_community_profiles").upsert(row, { onConflict: "user_id" });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      return json({ error: "unknown community action" }, 400);
    }

    // Published announcements for the member portal "Updates" view (any active member).
    if (action === "announcements_feed") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const { data } = await sb.from("t3l_announcements")
        .select("id,title,body,created_at").eq("published", true).order("created_at", { ascending: false }).limit(50);
      return json({ announcements: data || [] });
    }

    // Upcoming published events for the member portal (any active member).
    if (action === "events_list") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await sb.from("t3l_events")
        .select("id,title,location,description,start_date,start_time,end_date,end_time")
        .eq("published", true).gte("start_date", today)
        .order("start_date", { ascending: true }).order("start_time", { ascending: true, nullsFirst: true }).limit(100);
      return json({ events: data || [] });
    }

    // Published resources for the member portal "Resource library" (any active member).
    if (action === "resources_list") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const { data } = await sb.from("t3l_resources")
        .select("id,title,url,description,created_at")
        .eq("published", true).order("created_at", { ascending: false }).limit(200);
      return json({ resources: data || [] });
    }

    // ================= VOLUNTEER MODULE (any active member) =================
    if (action === "volunteer_opportunities") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const uid = caller.user.id;
      const nowIso = new Date().toISOString();
      const { data: opps } = await sb.from("t3l_volunteer_opportunities")
        .select("id,title,description,location,starts_at,ends_at,slots,role_id,sort")
        .eq("published", true)
        .or("ends_at.is.null,ends_at.gte." + nowIso)
        .order("starts_at", { ascending: true, nullsFirst: false }).order("sort", { ascending: true }).limit(100);
      const list = opps || [];
      const ids = list.map((o: any) => o.id);
      const roleIds = Array.from(new Set(list.map((o: any) => o.role_id).filter(Boolean)));
      const taken: Record<string, number> = {}; const mine: Record<string, boolean> = {};
      const roleMap: Record<string, string> = {};
      if (ids.length) {
        const { data: su } = await sb.from("t3l_volunteer_signups").select("opportunity_id,user_id,status").in("opportunity_id", ids).neq("status", "cancelled");
        (su || []).forEach((s: any) => { taken[s.opportunity_id] = (taken[s.opportunity_id] || 0) + 1; if (s.user_id === uid) mine[s.opportunity_id] = true; });
      }
      if (roleIds.length) {
        const { data: roles } = await sb.from("t3l_volunteer_roles").select("id,title").in("id", roleIds);
        (roles || []).forEach((r: any) => { roleMap[r.id] = r.title; });
      }
      const opportunities = list.map((o: any) => ({
        id: o.id, title: o.title, description: o.description, location: o.location,
        starts_at: o.starts_at, ends_at: o.ends_at, slots: o.slots,
        role_title: o.role_id ? (roleMap[o.role_id] || null) : null,
        taken: taken[o.id] || 0, full: o.slots != null && (taken[o.id] || 0) >= o.slots,
        signed_up: !!mine[o.id],
      }));
      return json({ opportunities });
    }

    if (action === "volunteer_signup") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const uid = caller.user.id;
      const opportunity_id = String(payload.opportunity_id || ""); if (!opportunity_id) return json({ error: "opportunity_id is required." }, 400);
      const { data: opp } = await sb.from("t3l_volunteer_opportunities").select("id,slots,published").eq("id", opportunity_id).maybeSingle();
      if (!opp || !opp.published) return json({ error: "That opportunity is no longer available." }, 404);
      if (opp.slots != null) {
        const { count } = await sb.from("t3l_volunteer_signups").select("id", { count: "exact", head: true }).eq("opportunity_id", opportunity_id).neq("status", "cancelled");
        const already = await sb.from("t3l_volunteer_signups").select("id,status").eq("opportunity_id", opportunity_id).eq("user_id", uid).maybeSingle();
        const iAmCounted = already.data && already.data.status !== "cancelled";
        if (!iAmCounted && (count || 0) >= opp.slots) return json({ error: "All slots for this opportunity are full." }, 409);
      }
      const row = { opportunity_id, user_id: uid, name: caller.member.full_name || null, email: caller.member.email || null, status: "signed_up", note: String(payload.note || "").trim() || null, updated_at: new Date().toISOString() };
      const { error } = await sb.from("t3l_volunteer_signups").upsert(row, { onConflict: "opportunity_id,user_id" });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "volunteer_cancel") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const opportunity_id = String(payload.opportunity_id || ""); if (!opportunity_id) return json({ error: "opportunity_id is required." }, 400);
      const { error } = await sb.from("t3l_volunteer_signups").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("opportunity_id", opportunity_id).eq("user_id", caller.user.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "volunteer_log_hours") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const hours = Number(payload.hours);
      if (!(hours > 0) || hours > 1000) return json({ error: "Enter the number of hours served (0–1000)." }, 400);
      const row = {
        user_id: caller.user.id,
        opportunity_id: String(payload.opportunity_id || "") || null,
        name: caller.member.full_name || null,
        hours: Math.round(hours * 100) / 100,
        served_on: String(payload.served_on || "").trim() || new Date().toISOString().slice(0, 10),
        description: String(payload.description || "").trim() || null,
        status: "pending",
      };
      const { error } = await sb.from("t3l_volunteer_hours").insert(row);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "volunteer_my_hours") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const { data } = await sb.from("t3l_volunteer_hours")
        .select("id,hours,served_on,description,status,created_at").eq("user_id", caller.user.id)
        .order("served_on", { ascending: false }).limit(100);
      const rows = data || [];
      let verified = 0, pending = 0;
      rows.forEach((r: any) => { if (r.status === "verified") verified += Number(r.hours) || 0; else if (r.status === "pending") pending += Number(r.hours) || 0; });
      return json({ hours: rows, totals: { verified: Math.round(verified * 100) / 100, pending: Math.round(pending * 100) / 100 } });
    }

    // ================= PRAYER WALL (any active member) =================
    if (action === "prayer_wall") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const uid = caller.user.id;
      const { data } = await sb.from("t3l_prayer_requests")
        .select("id,name,request,anonymous,answered,answered_note,created_at")
        .eq("on_wall", true).order("answered", { ascending: true }).order("created_at", { ascending: false }).limit(100);
      const list = data || [];
      const ids = list.map((r: any) => r.id);
      const counts: Record<string, number> = {}; const mine: Record<string, boolean> = {};
      if (ids.length) {
        const { data: prayed } = await sb.from("t3l_prayer_prayed").select("request_id,user_id").in("request_id", ids);
        (prayed || []).forEach((p: any) => { counts[p.request_id] = (counts[p.request_id] || 0) + 1; if (p.user_id === uid) mine[p.request_id] = true; });
      }
      const requests = list.map((r: any) => ({
        id: r.id, name: r.anonymous ? null : (r.name || null), request: r.request,
        answered: r.answered, answered_note: r.answered_note, created_at: r.created_at,
        prayed: counts[r.id] || 0, i_prayed: !!mine[r.id],
      }));
      return json({ requests });
    }

    if (action === "prayer_pray") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const request_id = String(payload.request_id || ""); if (!request_id) return json({ error: "request_id is required." }, 400);
      const { data: req } = await sb.from("t3l_prayer_requests").select("id,on_wall").eq("id", request_id).maybeSingle();
      if (!req || !req.on_wall) return json({ error: "That request is not on the prayer wall." }, 404);
      await sb.from("t3l_prayer_prayed").upsert({ request_id, user_id: caller.user.id }, { onConflict: "request_id,user_id" });
      const { count } = await sb.from("t3l_prayer_prayed").select("id", { count: "exact", head: true }).eq("request_id", request_id);
      return json({ ok: true, prayed: count || 0 });
    }

    // Member submits a request they'd like shared on the wall (held for admin review).
    if (action === "prayer_wall_submit") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const request = String(payload.request || "").trim();
      if (request.length < 2) return json({ error: "Please enter your prayer request." }, 400);
      const anonymous = payload.anonymous === true;
      const row = {
        user_id: caller.user.id,
        name: anonymous ? null : (caller.member.full_name || null),
        email: caller.member.email || null,
        request,
        anonymous,
        on_wall: false, // held for admin review before it appears on the wall
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from("t3l_prayer_requests").insert(row);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "app") {
      if (!caller) return json({ error: "unauthorized" }, 401);
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      // Super admins get the full console (with setup directions); regular
      // admins get the clean working view. Fall back to admin_app if the
      // super-admin console has not been seeded.
      const key = isSuper ? "admin_app_super" : "admin_app";
      let { data } = await sb.from("t3l_portal_assets").select("content").eq("key", key).maybeSingle();
      if ((!data || !data.content) && key !== "admin_app") {
        const fb = await sb.from("t3l_portal_assets").select("content").eq("key", "admin_app").maybeSingle();
        data = fb.data;
      }
      return json({ html: (data && data.content) || FALLBACK_HTML });
    }

    if (["invite", "list_members", "set_role", "revoke", "get_config", "set_config",
         "list_prayer_requests", "set_prayer_status", "set_module",
         "comms_announcement_list", "comms_announcement_save", "comms_announcement_delete",
         "comms_email_send", "comms_email_log",
         "events_admin_list", "event_save", "event_delete",
         "resources_admin_list", "resource_save", "resource_delete",
         "admin_overview",
         "volunteer_roles_admin", "volunteer_role_save", "volunteer_role_delete",
         "volunteer_opps_admin", "volunteer_opp_save", "volunteer_opp_delete",
         "volunteer_signups_admin", "volunteer_signup_set",
         "volunteer_hours_admin", "volunteer_hours_review",
         "impact_admin", "impact_metric_save", "impact_metric_delete",
         "impact_story_save", "impact_story_delete", "impact_settings_save",
         "prayer_wall_set",
         "email_journeys_admin", "email_journey_save", "email_journey_toggle", "email_journey_test",
         "crm_list", "crm_get", "crm_save", "crm_activity", "crm_archive", "crm_lookup",
         "crm_fields_list", "crm_field_save", "crm_field_delete",
         "crm_stages_list", "crm_stage_save", "crm_stage_set", "crm_households_list", "crm_household_save",
         "crm_tasks_list", "crm_task_save", "crm_task_toggle", "crm_import", "crm_export",
         "giving_funds_list", "giving_fund_save", "giving_gifts_list", "giving_gift_save",
         "giving_gift_delete", "giving_summary", "giving_statement",
         "giving_pledges_list", "giving_pledge_save"].includes(action)) {
      if (!caller) return json({ error: "unauthorized" }, 401);
      if (!isAdmin) return json({ error: "forbidden" }, 403);
    }

    if (action === "list_members") {
      const { data } = await sb.from("t3l_portal_members")
        .select("user_id,email,role,full_name,status,created_at").order("created_at", { ascending: true });
      return json({ members: data || [] });
    }

    if (action === "get_config") {
      const { data } = await sb.from("t3l_portal_config").select("key,value");
      const cfg: Record<string, string> = {};
      (data || []).forEach((r: any) => { cfg[r.key] = r.value || ""; });
      return json({ config: { admin_webhook_url: cfg["admin_webhook_url"] || "", client_announcement_webhook_url: cfg["client_announcement_webhook_url"] || "" } });
    }

    if (action === "set_config") {
      if (!isSuper) return json({ error: "Only a super administrator can change configuration." }, 403);
      const rows = [
        { key: "admin_webhook_url", value: String(payload.admin_webhook_url || ""), updated_at: new Date().toISOString() },
        { key: "client_announcement_webhook_url", value: String(payload.client_announcement_webhook_url || ""), updated_at: new Date().toISOString() },
      ];
      const { error } = await sb.from("t3l_portal_config").upsert(rows, { onConflict: "key" });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // --- Module on/off registry ---
    // Readable by any active member: the client portal uses it to hide features
    // (like Community) that a super admin has switched off. set_module is super-only.
    if (action === "get_modules") {
      if (!caller || !caller.member || caller.member.status !== "active") return json({ error: "unauthorized" }, 401);
      const { data } = await sb.from("t3l_portal_modules").select("key,enabled,label,sort").order("sort", { ascending: true });
      return json({ modules: data || [] });
    }

    if (action === "set_module") {
      if (!isSuper) return json({ error: "Only a super administrator can change modules." }, 403);
      const key = String(payload.key || "");
      if (!key) return json({ error: "key is required." }, 400);
      const { error } = await sb.from("t3l_portal_modules")
        .update({ enabled: !!payload.enabled, updated_at: new Date().toISOString() }).eq("key", key);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // --- Communications: portal announcements + email broadcasts (Resend) ---
    if (action === "comms_announcement_list") {
      const { data } = await sb.from("t3l_announcements")
        .select("id,title,body,published,created_at").order("created_at", { ascending: false }).limit(200);
      return json({ announcements: data || [] });
    }

    if (action === "comms_announcement_save") {
      const title = String(payload.title || "").trim(); if (!title) return json({ error: "Title is required." }, 400);
      const body = String(payload.body || "").trim(); if (body.length < 2) return json({ error: "Write the announcement." }, 400);
      const row = { title, body, published: payload.published === false ? false : true, updated_at: new Date().toISOString() };
      const id = String(payload.id || "");
      if (id) {
        const { error } = await sb.from("t3l_announcements").update(row).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      const { data, error } = await sb.from("t3l_announcements").insert({ ...row, created_by: caller!.user.id }).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, announcement: data });
    }

    if (action === "comms_announcement_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_announcements").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "comms_email_log") {
      const { data } = await sb.from("t3l_comms_email_log")
        .select("id,subject,audience,recipients,sent,failed,status,created_at").order("created_at", { ascending: false }).limit(100);
      return json({ log: data || [] });
    }

    if (action === "comms_email_send") {
      const subject = String(payload.subject || "").trim();
      const body = String(payload.body || "").trim();
      if (!subject) return json({ error: "Subject is required." }, 400);
      if (body.length < 2) return json({ error: "Write a message." }, 400);

      const audienceKey = String(payload.audience || "members");
      let emails: string[] = []; let label = "All members";
      if (audienceKey === "members") {
        const { data } = await sb.from("t3l_portal_members").select("email").eq("status", "active");
        emails = (data || []).map((r: any) => r.email); label = "All members";
      } else if (audienceKey === "crm_all") {
        const { data } = await sb.from("t3l_crm_contacts").select("email").eq("status", "active").not("email", "is", null);
        emails = (data || []).map((r: any) => r.email); label = "All CRM contacts";
      } else if (audienceKey.indexOf("crm_stage:") === 0) {
        const stage = audienceKey.slice("crm_stage:".length);
        const { data } = await sb.from("t3l_crm_contacts").select("email").eq("status", "active").eq("stage", stage).not("email", "is", null);
        emails = (data || []).map((r: any) => r.email); label = "CRM stage: " + stage;
      }

      const seen: Record<string, boolean> = {}; const list: string[] = [];
      emails.forEach((e) => { const k = String(e || "").toLowerCase().trim(); if (k && k.indexOf("@") > 0 && !seen[k]) { seen[k] = true; list.push(String(e).trim()); } });

      if (!list.length) {
        await sb.from("t3l_comms_email_log").insert({ subject, audience: label, recipients: 0, sent: 0, failed: 0, status: "no_recipients", created_by: caller!.user.id });
        return json({ error: "No recipients with an email address in that audience." }, 400);
      }
      if (!RESEND_API_KEY) {
        await sb.from("t3l_comms_email_log").insert({ subject, audience: label, recipients: list.length, sent: 0, failed: list.length, status: "not_configured", error: "RESEND_API_KEY not set", created_by: caller!.user.id });
        return json({ error: "Email sending is not configured yet. The Resend API key has not been added." }, 400);
      }

      const { data: cfg } = await sb.from("t3l_portal_config").select("value").eq("key", "comms_from_email").maybeSingle();
      const from = (cfg && cfg.value) || "Teach Them to Love <outreach@mail.28footsystems.com>";
      const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#2b2030;line-height:1.6;white-space:pre-wrap">' + escapeHtml(body) + '</div>';
      const cap = list.slice(0, 500); // safety cap per send
      let sent = 0, failed = 0; let firstErr = "";

      // Resend batch endpoint: up to 100 messages/call, each with its own single recipient
      // (so members never see one another's addresses).
      for (let i = 0; i < cap.length; i += 100) {
        const chunk = cap.slice(i, i + 100);
        const batch = chunk.map((to) => ({ from, to: [to], subject, html, text: body }));
        try {
          const res = await fetch("https://api.resend.com/emails/batch", {
            method: "POST",
            headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify(batch),
          });
          if (res.ok) { sent += chunk.length; }
          else { failed += chunk.length; if (!firstErr) { try { const j = await res.json(); firstErr = (j && (j.message || JSON.stringify(j))) || ("HTTP " + res.status); } catch (_e) { firstErr = "HTTP " + res.status; } } }
        } catch (e) { failed += chunk.length; if (!firstErr) firstErr = String((e as Error).message || e); }
      }
      const status = failed === 0 ? "sent" : (sent > 0 ? "partial" : "failed");
      await sb.from("t3l_comms_email_log").insert({ subject, audience: label, recipients: cap.length, sent, failed, status, error: firstErr || null, created_by: caller!.user.id });
      if (status === "failed") return json({ error: "Send failed: " + (firstErr || "unknown error") }, 400);
      return json({ ok: true, recipients: cap.length, sent, failed, status });
    }

    // --- Events (Supabase-backed; replaces the old GoHighLevel webhook form) ---
    if (action === "events_admin_list") {
      const { data } = await sb.from("t3l_events")
        .select("id,title,location,description,start_date,start_time,end_date,end_time,published")
        .order("start_date", { ascending: false }).limit(300);
      return json({ events: data || [] });
    }

    if (action === "event_save") {
      const title = String(payload.title || "").trim(); if (!title) return json({ error: "Event title is required." }, 400);
      const start_date = String(payload.start_date || "").trim(); if (!start_date) return json({ error: "A start date is required." }, 400);
      const row: Record<string, unknown> = {
        title,
        location: String(payload.location || "").trim() || null,
        description: String(payload.description || "").trim() || null,
        start_date,
        start_time: String(payload.start_time || "").trim() || null,  // blank => time to be determined
        end_date: String(payload.end_date || "").trim() || null,
        end_time: String(payload.end_time || "").trim() || null,
        published: payload.published === false ? false : true,
        updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      if (id) {
        const { error } = await sb.from("t3l_events").update(row).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      const { data, error } = await sb.from("t3l_events").insert({ ...row, created_by: caller!.user.id }).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, event: data });
    }

    if (action === "event_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_events").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // --- Resources (Supabase-backed; replaces the old GoHighLevel webhook form) ---
    if (action === "resources_admin_list") {
      const { data } = await sb.from("t3l_resources")
        .select("id,title,url,description,published,created_at")
        .order("created_at", { ascending: false }).limit(300);
      return json({ resources: data || [] });
    }

    if (action === "resource_save") {
      const title = String(payload.title || "").trim(); if (!title) return json({ error: "A resource title is required." }, 400);
      const url = String(payload.url || "").trim(); if (!url) return json({ error: "A resource URL is required." }, 400);
      const row: Record<string, unknown> = {
        title,
        url,
        description: String(payload.description || "").trim() || null,
        published: payload.published === false ? false : true,
        updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      if (id) {
        const { error } = await sb.from("t3l_resources").update(row).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      const { data, error } = await sb.from("t3l_resources").insert({ ...row, created_by: caller!.user.id }).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, resource: data });
    }

    if (action === "resource_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_resources").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // --- Admin dashboard overview: live counts + the next few upcoming events ---
    if (action === "admin_overview") {
      const today = new Date().toISOString().slice(0, 10);
      const nowIso = new Date().toISOString();
      const [prayer, events, upcoming, anns, resources, hoursPending, wallPending, openOpps] = await Promise.all([
        sb.from("t3l_prayer_requests").select("id", { count: "exact", head: true }).neq("status", "closed"),
        sb.from("t3l_events").select("id", { count: "exact", head: true }).eq("published", true).gte("start_date", today),
        sb.from("t3l_events").select("id,title,location,start_date,start_time,published")
          .eq("published", true).gte("start_date", today)
          .order("start_date", { ascending: true }).order("start_time", { ascending: true, nullsFirst: true }).limit(5),
        sb.from("t3l_announcements").select("id", { count: "exact", head: true }).eq("published", true),
        sb.from("t3l_resources").select("id", { count: "exact", head: true }).eq("published", true),
        sb.from("t3l_volunteer_hours").select("id", { count: "exact", head: true }).eq("status", "pending"),
        sb.from("t3l_prayer_requests").select("id", { count: "exact", head: true }).eq("on_wall", false).neq("status", "closed"),
        sb.from("t3l_volunteer_opportunities").select("id", { count: "exact", head: true }).eq("published", true).or("ends_at.is.null,ends_at.gte." + nowIso),
      ]);
      return json({
        counts: {
          prayer_pending: prayer.count || 0,
          upcoming_events: events.count || 0,
          announcements: anns.count || 0,
          resources: resources.count || 0,
          volunteer_hours_pending: hoursPending.count || 0,
          prayer_wall_pending: wallPending.count || 0,
          open_opportunities: openOpps.count || 0,
        },
        upcoming_events: upcoming.data || [],
      });
    }

    // ================= VOLUNTEER ADMIN =================
    if (action === "volunteer_roles_admin") {
      const { data } = await sb.from("t3l_volunteer_roles")
        .select("id,title,description,category,time_commitment,active,sort").order("sort", { ascending: true }).order("title", { ascending: true });
      return json({ roles: data || [] });
    }
    if (action === "volunteer_role_save") {
      const title = String(payload.title || "").trim(); if (!title) return json({ error: "A role title is required." }, 400);
      const row: Record<string, unknown> = {
        title,
        description: String(payload.description || "").trim() || null,
        category: String(payload.category || "").trim() || null,
        time_commitment: String(payload.time_commitment || "").trim() || null,
        active: payload.active === false ? false : true,
        sort: parseInt(String(payload.sort || "0"), 10) || 0,
        updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      if (id) { const { error } = await sb.from("t3l_volunteer_roles").update(row).eq("id", id); if (error) return json({ error: error.message }, 400); return json({ ok: true }); }
      const { error } = await sb.from("t3l_volunteer_roles").insert({ ...row, created_by: caller!.user.id });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "volunteer_role_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_volunteer_roles").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "volunteer_opps_admin") {
      const { data } = await sb.from("t3l_volunteer_opportunities")
        .select("id,role_id,event_id,title,description,location,starts_at,ends_at,slots,published,sort")
        .order("starts_at", { ascending: false, nullsFirst: false }).order("sort", { ascending: true }).limit(300);
      const list = data || [];
      const ids = list.map((o: any) => o.id);
      const counts: Record<string, number> = {};
      if (ids.length) {
        const { data: su } = await sb.from("t3l_volunteer_signups").select("opportunity_id,status").in("opportunity_id", ids).neq("status", "cancelled");
        (su || []).forEach((s: any) => { counts[s.opportunity_id] = (counts[s.opportunity_id] || 0) + 1; });
      }
      const opps = list.map((o: any) => ({ ...o, signups: counts[o.id] || 0 }));
      return json({ opportunities: opps });
    }
    if (action === "volunteer_opp_save") {
      const title = String(payload.title || "").trim(); if (!title) return json({ error: "An opportunity title is required." }, 400);
      const slotsRaw = String(payload.slots == null ? "" : payload.slots).trim();
      const row: Record<string, unknown> = {
        role_id: String(payload.role_id || "") || null,
        event_id: String(payload.event_id || "") || null,
        title,
        description: String(payload.description || "").trim() || null,
        location: String(payload.location || "").trim() || null,
        starts_at: String(payload.starts_at || "").trim() || null,
        ends_at: String(payload.ends_at || "").trim() || null,
        slots: slotsRaw ? (parseInt(slotsRaw, 10) || null) : null,
        published: payload.published === false ? false : true,
        sort: parseInt(String(payload.sort || "0"), 10) || 0,
        updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      if (id) { const { error } = await sb.from("t3l_volunteer_opportunities").update(row).eq("id", id); if (error) return json({ error: error.message }, 400); return json({ ok: true }); }
      const { error } = await sb.from("t3l_volunteer_opportunities").insert({ ...row, created_by: caller!.user.id });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "volunteer_opp_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_volunteer_opportunities").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "volunteer_signups_admin") {
      const opportunity_id = String(payload.opportunity_id || ""); if (!opportunity_id) return json({ error: "opportunity_id is required." }, 400);
      const { data } = await sb.from("t3l_volunteer_signups")
        .select("id,user_id,name,email,status,note,created_at").eq("opportunity_id", opportunity_id).order("created_at", { ascending: true });
      return json({ signups: data || [] });
    }
    if (action === "volunteer_signup_set") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const status = String(payload.status || "");
      if (["signed_up", "confirmed", "attended", "cancelled", "no_show"].indexOf(status) < 0) return json({ error: "Invalid status." }, 400);
      const { error } = await sb.from("t3l_volunteer_signups").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "volunteer_hours_admin") {
      const status = String(payload.status || "");
      let q = sb.from("t3l_volunteer_hours").select("id,user_id,name,hours,served_on,description,status,created_at").order("created_at", { ascending: false }).limit(300);
      if (status) q = q.eq("status", status);
      const { data } = await q;
      const rows = data || [];
      const [pend, ver] = await Promise.all([
        sb.from("t3l_volunteer_hours").select("hours").eq("status", "pending"),
        sb.from("t3l_volunteer_hours").select("hours").eq("status", "verified"),
      ]);
      const sum = (arr: any[]) => Math.round((arr || []).reduce((a, r) => a + (Number(r.hours) || 0), 0) * 100) / 100;
      return json({ hours: rows, totals: { pending: sum(pend.data || []), verified: sum(ver.data || []) } });
    }
    if (action === "volunteer_hours_review") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const decision = String(payload.decision || "");
      if (decision !== "verified" && decision !== "rejected") return json({ error: "decision must be verified or rejected." }, 400);
      const { error } = await sb.from("t3l_volunteer_hours").update({ status: decision, verified_by: caller!.user.id, verified_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ================= IMPACT ADMIN =================
    if (action === "impact_admin") {
      const today = new Date().toISOString().slice(0, 10);
      const [settings, metrics, stories, members, eventsHosted, lessons, posts, hoursRows, prayers] = await Promise.all([
        sb.from("t3l_impact_settings").select("headline,intro").eq("id", 1).maybeSingle(),
        sb.from("t3l_impact_metrics").select("id,label,value,unit,icon,published,sort").order("sort", { ascending: true }),
        sb.from("t3l_impact_stories").select("id,title,summary,body,image_url,published,sort,created_at").order("sort", { ascending: true }),
        sb.from("t3l_portal_members").select("user_id", { count: "exact", head: true }).eq("status", "active"),
        sb.from("t3l_events").select("id", { count: "exact", head: true }).eq("published", true).lt("start_date", today),
        sb.from("t3l_community_lessons").select("id", { count: "exact", head: true }).eq("published", true),
        sb.from("t3l_community_posts").select("id", { count: "exact", head: true }).eq("hidden", false),
        sb.from("t3l_volunteer_hours").select("hours").eq("status", "verified"),
        sb.from("t3l_prayer_prayed").select("id", { count: "exact", head: true }),
      ]);
      let vh = 0; (hoursRows.data || []).forEach((r: any) => { vh += Number(r.hours) || 0; });
      return json({
        settings: settings.data || { headline: "Our Impact", intro: "" },
        metrics: metrics.data || [], stories: stories.data || [],
        auto: {
          community_members: members.count || 0, events_hosted: eventsHosted.count || 0,
          classroom_lessons: lessons.count || 0, community_posts: posts.count || 0,
          volunteer_hours: Math.round(vh), prayers_covered: prayers.count || 0,
        },
      });
    }
    if (action === "impact_metric_save") {
      const label = String(payload.label || "").trim(); if (!label) return json({ error: "A metric label is required." }, 400);
      const value = String(payload.value || "").trim(); if (!value) return json({ error: "A metric value is required." }, 400);
      const row: Record<string, unknown> = {
        label, value, unit: String(payload.unit || "").trim() || null, icon: String(payload.icon || "").trim() || null,
        published: payload.published === false ? false : true, sort: parseInt(String(payload.sort || "0"), 10) || 0,
        updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      if (id) { const { error } = await sb.from("t3l_impact_metrics").update(row).eq("id", id); if (error) return json({ error: error.message }, 400); return json({ ok: true }); }
      const { error } = await sb.from("t3l_impact_metrics").insert(row);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "impact_metric_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_impact_metrics").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "impact_story_save") {
      const title = String(payload.title || "").trim(); if (!title) return json({ error: "A story title is required." }, 400);
      const row: Record<string, unknown> = {
        title, summary: String(payload.summary || "").trim() || null, body: String(payload.body || "").trim() || null,
        image_url: String(payload.image_url || "").trim() || null,
        published: payload.published === false ? false : true, sort: parseInt(String(payload.sort || "0"), 10) || 0,
        updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      if (id) { const { error } = await sb.from("t3l_impact_stories").update(row).eq("id", id); if (error) return json({ error: error.message }, 400); return json({ ok: true }); }
      const { error } = await sb.from("t3l_impact_stories").insert({ ...row, created_by: caller!.user.id });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "impact_story_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_impact_stories").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "impact_settings_save") {
      const row = { id: 1, headline: String(payload.headline || "Our Impact").trim() || "Our Impact", intro: String(payload.intro || "").trim() || null, updated_at: new Date().toISOString() };
      const { error } = await sb.from("t3l_impact_settings").upsert(row, { onConflict: "id" });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ================= PRAYER WALL MODERATION =================
    if (action === "prayer_wall_set") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (payload.on_wall !== undefined) patch.on_wall = payload.on_wall === true;
      if (payload.anonymous !== undefined) patch.anonymous = payload.anonymous === true;
      if (payload.answered !== undefined) patch.answered = payload.answered === true;
      if (payload.answered_note !== undefined) patch.answered_note = String(payload.answered_note || "").trim() || null;
      const { error } = await sb.from("t3l_prayer_requests").update(patch).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ================= EMAIL JOURNEYS ADMIN =================
    if (action === "email_journeys_admin") {
      const { data: journeys } = await sb.from("t3l_email_journeys")
        .select("id,key,name,trigger_type,subject,body,delay_hours,lead_hours,inactive_days,active,updated_at").order("key", { ascending: true });
      const { data: log } = await sb.from("t3l_email_journey_log")
        .select("journey_key,status,sent_at").order("sent_at", { ascending: false }).limit(300);
      const stats: Record<string, { sent: number; failed: number; last: string | null }> = {};
      (log || []).forEach((r: any) => {
        const s = stats[r.journey_key] || { sent: 0, failed: 0, last: null };
        if (r.status === "sent") s.sent++; else if (r.status === "failed") s.failed++;
        if (!s.last) s.last = r.sent_at;
        stats[r.journey_key] = s;
      });
      const { data: cronCfg } = await sb.from("t3l_portal_config").select("value").eq("key", "cron_secret").maybeSingle();
      return json({ journeys: journeys || [], stats, cron_configured: !!(cronCfg && cronCfg.value), email_configured: !!RESEND_API_KEY });
    }
    if (action === "email_journey_save") {
      const key = String(payload.key || ""); if (!key) return json({ error: "key is required." }, 400);
      const subject = String(payload.subject || "").trim(); if (!subject) return json({ error: "A subject is required." }, 400);
      const body = String(payload.body || "").trim(); if (body.length < 2) return json({ error: "Write the email body." }, 400);
      const patch: Record<string, unknown> = {
        name: String(payload.name || "").trim() || undefined,
        subject, body,
        delay_hours: payload.delay_hours !== undefined ? (parseInt(String(payload.delay_hours), 10) || 0) : undefined,
        lead_hours: payload.lead_hours !== undefined ? (parseInt(String(payload.lead_hours), 10) || 0) : undefined,
        inactive_days: payload.inactive_days !== undefined ? (parseInt(String(payload.inactive_days), 10) || 0) : undefined,
        updated_at: new Date().toISOString(),
      };
      Object.keys(patch).forEach((k) => { if (patch[k] === undefined) delete patch[k]; });
      const { error } = await sb.from("t3l_email_journeys").update(patch).eq("key", key);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    if (action === "email_journey_toggle") {
      const key = String(payload.key || ""); if (!key) return json({ error: "key is required." }, 400);
      const active = payload.active === true;
      const { error } = await sb.from("t3l_email_journeys").update({ active, updated_at: new Date().toISOString() }).eq("key", key);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, active });
    }
    if (action === "email_journey_test") {
      const key = String(payload.key || ""); if (!key) return json({ error: "key is required." }, 400);
      const to = caller!.member.email; if (!to) return json({ error: "Your account has no email address to send a test to." }, 400);
      if (!RESEND_API_KEY) return json({ error: "Email sending is not configured yet (RESEND_API_KEY not set)." }, 400);
      const { data: j } = await sb.from("t3l_email_journeys").select("subject,body").eq("key", key).maybeSingle();
      if (!j) return json({ error: "Journey not found." }, 404);
      const vars: Record<string, string> = { name: (caller!.member.full_name || "there"), event_title: "Sample Event", event_date: "a future date" };
      const render = (s: string) => String(s || "").replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => (vars[k] != null ? vars[k] : ""));
      const { data: cfg } = await sb.from("t3l_portal_config").select("value").eq("key", "comms_from_email").maybeSingle();
      const from = (cfg && cfg.value) || "Teach Them to Love <outreach@mail.28footsystems.com>";
      const text = render(j.body); const subject = "[TEST] " + render(j.subject);
      const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#2b2030;line-height:1.6;white-space:pre-wrap">' + escapeHtml(text) + '</div>';
      try {
        const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, html, text }) });
        if (!res.ok) { let e = "HTTP " + res.status; try { const jj = await res.json(); e = (jj && (jj.message || JSON.stringify(jj))) || e; } catch (_x) { /* noop */ } return json({ error: "Test send failed: " + e }, 400); }
      } catch (e) { return json({ error: "Test send failed: " + String((e as Error).message || e) }, 400); }
      return json({ ok: true, sent_to: to });
    }

    // --- CRM: contacts + activity ---
    if (action === "crm_list") {
      const q = String(payload.q || "").trim();
      let query = sb.from("t3l_crm_contacts")
        .select("id,first_name,last_name,email,phone,stage,tags,status,updated_at")
        .eq("status", "active").order("updated_at", { ascending: false }).limit(300);
      if (q) {
        const like = "%" + q.replace(/[%_,]/g, " ") + "%";
        query = query.or("first_name.ilike." + like + ",last_name.ilike." + like + ",email.ilike." + like + ",phone.ilike." + like);
      }
      const { data, error } = await query;
      if (error) return json({ error: error.message }, 400);
      return json({ contacts: data || [] });
    }

    // Lightweight contact finder for dedupe + typeahead wiring (gift form, import, etc.)
    if (action === "crm_lookup") {
      const email = String(payload.email || "").trim().toLowerCase();
      // Exact-email match first: used to auto-wire a gift/record to an existing contact.
      if (email) {
        const { data } = await sb.from("t3l_crm_contacts")
          .select("id,first_name,last_name,email,stage").eq("status", "active").ilike("email", email).limit(5);
        return json({ contacts: data || [], matched_email: (data && data.length) ? email : "" });
      }
      const q = String(payload.q || "").trim();
      if (!q) return json({ contacts: [] });
      const like = "%" + q.replace(/[%_,]/g, " ") + "%";
      const { data } = await sb.from("t3l_crm_contacts")
        .select("id,first_name,last_name,email,stage").eq("status", "active")
        .or("first_name.ilike." + like + ",last_name.ilike." + like + ",email.ilike." + like)
        .order("updated_at", { ascending: false }).limit(8);
      return json({ contacts: data || [] });
    }

    if (action === "crm_get") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { data: contact } = await sb.from("t3l_crm_contacts").select("*").eq("id", id).maybeSingle();
      if (!contact) return json({ error: "That contact was not found." }, 404);
      const { data: activities } = await sb.from("t3l_crm_activities")
        .select("id,kind,body,created_at").eq("contact_id", id).order("created_at", { ascending: false });
      const { data: tasks } = await sb.from("t3l_crm_tasks")
        .select("id,title,due_date,done").eq("contact_id", id).order("done", { ascending: true }).order("due_date", { ascending: true });
      const { data: gifts } = await sb.from("t3l_giving_gifts")
        .select("id,amount_cents,fund_id,method,gift_date").eq("contact_id", id).order("gift_date", { ascending: false });
      const { data: fields } = await sb.from("t3l_crm_fields")
        .select("key,label,type,options,sort").eq("active", true).order("sort", { ascending: true });
      return json({ contact, activities: activities || [], tasks: tasks || [], gifts: gifts || [], fields: fields || [] });
    }

    if (action === "crm_save") {
      const row: Record<string, unknown> = {
        first_name: String(payload.first_name || "").trim() || null,
        last_name: String(payload.last_name || "").trim() || null,
        email: String(payload.email || "").trim() || null,
        phone: String(payload.phone || "").trim() || null,
        stage: String(payload.stage || "new").trim() || "new",
        tags: Array.isArray(payload.tags) ? payload.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 25) : [],
        notes: String(payload.notes || "") || null,
        updated_at: new Date().toISOString(),
      };
      if (!row.first_name && !row.last_name && !row.email) return json({ error: "Enter a name or email." }, 400);
      if (payload.custom && typeof payload.custom === "object" && !Array.isArray(payload.custom)) row.custom = payload.custom;
      if ("household_id" in payload) row.household_id = payload.household_id ? String(payload.household_id) : null;
      if (payload.stage) row.stage = String(payload.stage).trim();
      const id = String(payload.id || "");
      if (id) {
        const { data, error } = await sb.from("t3l_crm_contacts").update(row).eq("id", id).select().maybeSingle();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, contact: data });
      }
      row.created_by = caller!.user.id;
      const { data, error } = await sb.from("t3l_crm_contacts").insert(row).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, contact: data });
    }

    if (action === "crm_activity") {
      const contact_id = String(payload.contact_id || ""); if (!contact_id) return json({ error: "contact_id is required." }, 400);
      const kind = ["note", "call", "email", "visit", "stage_change", "other"].includes(payload.kind) ? payload.kind : "note";
      const body = String(payload.body || "").trim(); if (!body) return json({ error: "Add a note first." }, 400);
      const { data, error } = await sb.from("t3l_crm_activities")
        .insert({ contact_id, kind, body, created_by: caller!.user.id }).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      await sb.from("t3l_crm_contacts").update({ updated_at: new Date().toISOString() }).eq("id", contact_id);
      return json({ ok: true, activity: data });
    }

    if (action === "crm_archive") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_crm_contacts")
        .update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // --- Deeper CRM: custom fields, stages, households, tasks, import/export ---
    if (action === "crm_fields_list") {
      const { data } = await sb.from("t3l_crm_fields").select("id,key,label,type,options,sort,active").order("sort", { ascending: true });
      return json({ fields: data || [] });
    }

    if (action === "crm_field_save") {
      const label = String(payload.label || "").trim(); if (!label) return json({ error: "Field label is required." }, 400);
      const type = ["text", "number", "date", "select"].includes(payload.type) ? payload.type : "text";
      const options = Array.isArray(payload.options) ? payload.options.map((o: any) => String(o).trim()).filter(Boolean) : [];
      const id = String(payload.id || "");
      if (id) {
        const { error } = await sb.from("t3l_crm_fields").update({ label, type, options, sort: Number(payload.sort) || 0, active: payload.active === false ? false : true }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      let key = String(payload.key || label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
      if (!key) key = "field_" + Date.now();
      const { error } = await sb.from("t3l_crm_fields").insert({ key, label, type, options, sort: Number(payload.sort) || 0 });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, key });
    }

    if (action === "crm_field_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_crm_fields").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "crm_stages_list") {
      const { data } = await sb.from("t3l_crm_stages").select("id,key,label,sort,active").order("sort", { ascending: true });
      return json({ stages: data || [] });
    }

    if (action === "crm_stage_save") {
      const label = String(payload.label || "").trim(); if (!label) return json({ error: "Stage label is required." }, 400);
      const id = String(payload.id || "");
      if (id) {
        const { error } = await sb.from("t3l_crm_stages").update({ label, sort: Number(payload.sort) || 0, active: payload.active === false ? false : true }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      let key = String(payload.key || label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
      if (!key) key = "stage_" + Date.now();
      const { error } = await sb.from("t3l_crm_stages").insert({ key, label, sort: Number(payload.sort) || 0 });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, key });
    }

    // Pipeline board: move the SAME contact record to a new stage, and log the move in its timeline.
    if (action === "crm_stage_set") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const stage = String(payload.stage || "").trim(); if (!stage) return json({ error: "stage is required." }, 400);
      const { data: before } = await sb.from("t3l_crm_contacts").select("stage").eq("id", id).maybeSingle();
      const { error } = await sb.from("t3l_crm_contacts")
        .update({ stage, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      if (before && before.stage !== stage) {
        await sb.from("t3l_crm_activities").insert({
          contact_id: id, kind: "stage_change",
          body: "Stage changed from " + before.stage + " to " + stage, created_by: caller!.user.id,
        });
      }
      return json({ ok: true, stage });
    }

    if (action === "crm_households_list") {
      const { data } = await sb.from("t3l_crm_households").select("id,name").order("name", { ascending: true });
      return json({ households: data || [] });
    }

    if (action === "crm_household_save") {
      const name = String(payload.name || "").trim(); if (!name) return json({ error: "Household name is required." }, 400);
      const id = String(payload.id || "");
      if (id) {
        const { error } = await sb.from("t3l_crm_households").update({ name }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      const { data, error } = await sb.from("t3l_crm_households").insert({ name }).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, household: data });
    }

    if (action === "crm_tasks_list") {
      let query = sb.from("t3l_crm_tasks").select("id,contact_id,title,due_date,done")
        .order("done", { ascending: true }).order("due_date", { ascending: true }).limit(500);
      if (payload.contact_id) query = query.eq("contact_id", String(payload.contact_id));
      if (payload.open) query = query.eq("done", false);
      const { data, error } = await query;
      if (error) return json({ error: error.message }, 400);
      return json({ tasks: data || [] });
    }

    if (action === "crm_task_save") {
      const title = String(payload.title || "").trim(); if (!title) return json({ error: "Task title is required." }, 400);
      const rowt: Record<string, unknown> = {
        contact_id: payload.contact_id ? String(payload.contact_id) : null,
        title, due_date: payload.due_date ? String(payload.due_date) : null, updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      if (id) {
        const { error } = await sb.from("t3l_crm_tasks").update(rowt).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      rowt.created_by = caller!.user.id;
      const { data, error } = await sb.from("t3l_crm_tasks").insert(rowt).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, task: data });
    }

    if (action === "crm_task_toggle") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_crm_tasks").update({ done: !!payload.done, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "crm_export") {
      const { data } = await sb.from("t3l_crm_contacts")
        .select("first_name,last_name,email,phone,stage,tags,notes,status").eq("status", "active")
        .order("last_name", { ascending: true }).limit(5000);
      return json({ contacts: data || [] });
    }

    if (action === "crm_import") {
      const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 2000) : [];
      if (!rows.length) return json({ error: "No rows to import." }, 400);
      const clean = rows.map((r: any) => ({
        first_name: String(r.first_name || "").trim() || null,
        last_name: String(r.last_name || "").trim() || null,
        email: String(r.email || "").trim() || null,
        phone: String(r.phone || "").trim() || null,
        stage: String(r.stage || "new").trim() || "new",
        tags: Array.isArray(r.tags) ? r.tags.map((t: any) => String(t).trim()).filter(Boolean) : [],
      })).filter((r: any) => r.first_name || r.last_name || r.email);
      if (!clean.length) return json({ error: "No valid rows (each needs a name or email)." }, 400);

      // Seamless wiring: a row whose email already belongs to a contact UPDATES that
      // contact instead of creating a duplicate. Rows without an email always insert.
      const emails = Array.from(new Set(clean.map((r: any) => (r.email || "").toLowerCase()).filter(Boolean)));
      const existing: Record<string, string> = {};
      if (emails.length) {
        const { data: found } = await sb.from("t3l_crm_contacts")
          .select("id,email").eq("status", "active").in("email", emails);
        (found || []).forEach((c: any) => { if (c.email) existing[String(c.email).toLowerCase()] = c.id; });
      }
      let inserted = 0, updated = 0;
      const toInsert: any[] = [];
      for (const r of clean) {
        const key = (r.email || "").toLowerCase();
        const hitId = key ? existing[key] : null;
        if (hitId) {
          const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
          // Only fill fields the import actually provides; never blank out existing data.
          if (r.first_name) upd.first_name = r.first_name;
          if (r.last_name) upd.last_name = r.last_name;
          if (r.phone) upd.phone = r.phone;
          if (r.stage && r.stage !== "new") upd.stage = r.stage;
          const { error } = await sb.from("t3l_crm_contacts").update(upd).eq("id", hitId);
          if (!error) updated++;
        } else {
          toInsert.push({ ...r, created_by: caller!.user.id });
          if (key) existing[key] = "pending"; // dedupe within the same import batch
        }
      }
      if (toInsert.length) {
        const { data, error } = await sb.from("t3l_crm_contacts").insert(toInsert).select("id");
        if (error) return json({ error: error.message }, 400);
        inserted = (data || []).length;
      }
      return json({ ok: true, inserted, updated });
    }

    // --- Giving: funds, gifts, pledges, reports, statements (amounts in cents) ---
    if (action === "giving_funds_list") {
      const { data } = await sb.from("t3l_giving_funds").select("id,name,active,sort").order("sort", { ascending: true });
      return json({ funds: data || [] });
    }

    if (action === "giving_fund_save") {
      const name = String(payload.name || "").trim();
      if (!name) return json({ error: "Fund name is required." }, 400);
      const rowf = { name, active: payload.active === false ? false : true, sort: Number(payload.sort) || 0 };
      const id = String(payload.id || "");
      const res = id
        ? await sb.from("t3l_giving_funds").update(rowf).eq("id", id)
        : await sb.from("t3l_giving_funds").insert(rowf);
      if (res.error) return json({ error: res.error.message }, 400);
      return json({ ok: true });
    }

    if (action === "giving_gifts_list") {
      let query = sb.from("t3l_giving_gifts")
        .select("id,contact_id,donor_name,donor_email,amount_cents,fund_id,method,gift_date,note")
        .order("gift_date", { ascending: false }).limit(1000);
      if (payload.from) query = query.gte("gift_date", String(payload.from));
      if (payload.to) query = query.lte("gift_date", String(payload.to));
      if (payload.fund_id) query = query.eq("fund_id", String(payload.fund_id));
      if (payload.contact_id) query = query.eq("contact_id", String(payload.contact_id));
      if (payload.donor_email) query = query.ilike("donor_email", String(payload.donor_email));
      const { data, error } = await query;
      if (error) return json({ error: error.message }, 400);
      const total = (data || []).reduce((s: number, g: any) => s + (g.amount_cents || 0), 0);
      return json({ gifts: data || [], total_cents: total });
    }

    if (action === "giving_gift_save") {
      const cents = Math.round(Number(payload.amount_cents));
      if (!cents || Number.isNaN(cents) || cents < 1) return json({ error: "Enter a gift amount." }, 400);
      const donorName = String(payload.donor_name || "").trim();
      const donorEmail = String(payload.donor_email || "").trim();
      let contactId = payload.contact_id ? String(payload.contact_id) : "";
      let linked: any = null; // reported back so the UI can confirm the wiring

      // Seamless wiring: if this gift isn't already tied to a CRM contact, try to wire it.
      if (!contactId) {
        if (donorEmail) {
          const { data: hit } = await sb.from("t3l_crm_contacts")
            .select("id,first_name,last_name,email").eq("status", "active").ilike("email", donorEmail).limit(1);
          if (hit && hit.length) { contactId = hit[0].id; linked = { ...hit[0], created: false }; }
        }
        // No existing contact, but the UI asked to add the donor to the CRM at the same time.
        if (!contactId && payload.create_contact && (donorName || donorEmail)) {
          const parts = donorName.split(/\s+/);
          const first = parts.shift() || donorName || null;
          const last = parts.length ? parts.join(" ") : null;
          const { data: made } = await sb.from("t3l_crm_contacts")
            .insert({ first_name: first, last_name: last, email: donorEmail || null, stage: "donor", created_by: caller!.user.id })
            .select("id,first_name,last_name,email").maybeSingle();
          if (made) { contactId = made.id; linked = { ...made, created: true }; }
        }
      }

      const rowg: Record<string, unknown> = {
        contact_id: contactId || null,
        donor_name: donorName || null,
        donor_email: donorEmail || null,
        amount_cents: cents,
        fund_id: payload.fund_id ? String(payload.fund_id) : null,
        method: ["cash", "check", "paypal", "cashapp", "card", "other"].includes(payload.method) ? payload.method : "other",
        gift_date: String(payload.gift_date || "").trim() || new Date().toISOString().slice(0, 10),
        note: String(payload.note || "") || null,
        updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      if (id) {
        const { data, error } = await sb.from("t3l_giving_gifts").update(rowg).eq("id", id).select().maybeSingle();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, gift: data, linked });
      }
      rowg.created_by = caller!.user.id;
      const { data, error } = await sb.from("t3l_giving_gifts").insert(rowg).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, gift: data, linked });
    }

    if (action === "giving_gift_delete") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { error } = await sb.from("t3l_giving_gifts").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "giving_summary") {
      const year = parseInt(String(payload.year || new Date().getFullYear()), 10);
      const { data, error } = await sb.from("t3l_giving_gifts")
        .select("amount_cents,fund_id,gift_date").gte("gift_date", year + "-01-01").lte("gift_date", year + "-12-31").limit(100000);
      if (error) return json({ error: error.message }, 400);
      const byFund: Record<string, number> = {}; const byMonth = new Array(12).fill(0); let grand = 0;
      (data || []).forEach((g: any) => {
        grand += g.amount_cents || 0;
        const fk = g.fund_id || "none"; byFund[fk] = (byFund[fk] || 0) + (g.amount_cents || 0);
        const m = parseInt(String(g.gift_date).slice(5, 7), 10) - 1; if (m >= 0 && m < 12) byMonth[m] += g.amount_cents || 0;
      });
      return json({ year, grand_cents: grand, by_fund: byFund, by_month: byMonth, count: (data || []).length });
    }

    if (action === "giving_statement") {
      const email = String(payload.donor_email || "").trim().toLowerCase();
      if (!email) return json({ error: "Donor email is required." }, 400);
      const year = parseInt(String(payload.year || new Date().getFullYear()), 10);
      const { data, error } = await sb.from("t3l_giving_gifts")
        .select("amount_cents,fund_id,method,gift_date,note,donor_name")
        .ilike("donor_email", email).gte("gift_date", year + "-01-01").lte("gift_date", year + "-12-31")
        .order("gift_date", { ascending: true });
      if (error) return json({ error: error.message }, 400);
      const total = (data || []).reduce((s: number, g: any) => s + (g.amount_cents || 0), 0);
      const donor_name = (data || []).map((g: any) => g.donor_name).filter(Boolean)[0] || "";
      return json({ year, donor_email: email, donor_name, gifts: data || [], total_cents: total });
    }

    if (action === "giving_pledges_list") {
      const { data } = await sb.from("t3l_giving_pledges")
        .select("id,donor_name,donor_email,amount_cents,fund_id,frequency,start_date,end_date,status,note")
        .order("created_at", { ascending: false }).limit(500);
      return json({ pledges: data || [] });
    }

    if (action === "giving_pledge_save") {
      const cents = Math.round(Number(payload.amount_cents));
      if (!cents || Number.isNaN(cents) || cents < 1) return json({ error: "Enter a pledge amount." }, 400);
      const rowp: Record<string, unknown> = {
        donor_name: String(payload.donor_name || "").trim() || null,
        donor_email: String(payload.donor_email || "").trim() || null,
        amount_cents: cents,
        fund_id: payload.fund_id ? String(payload.fund_id) : null,
        frequency: ["one_time", "weekly", "monthly", "yearly"].includes(payload.frequency) ? payload.frequency : "monthly",
        start_date: payload.start_date ? String(payload.start_date) : null,
        end_date: payload.end_date ? String(payload.end_date) : null,
        status: ["active", "completed", "cancelled"].includes(payload.status) ? payload.status : "active",
        note: String(payload.note || "") || null,
        updated_at: new Date().toISOString(),
      };
      const id = String(payload.id || "");
      const res = id
        ? await sb.from("t3l_giving_pledges").update(rowp).eq("id", id)
        : await sb.from("t3l_giving_pledges").insert(rowp);
      if (res.error) return json({ error: res.error.message }, 400);
      return json({ ok: true });
    }

    if (action === "list_prayer_requests") {
      const { data } = await sb.from("t3l_prayer_requests")
        .select("id,name,email,ministry_role,request,status,internal_note,on_wall,anonymous,answered,answered_note,created_at")
        .order("created_at", { ascending: false });
      return json({ requests: data || [] });
    }

    if (action === "set_prayer_status") {
      const id = String(payload.id || "");
      const status = payload.status === "in_prayer" ? "in_prayer" : payload.status === "closed" ? "closed" : "received";
      if (!id) return json({ error: "id is required." }, 400);
      const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (typeof payload.internal_note === "string") patch.internal_note = payload.internal_note;
      const { error } = await sb.from("t3l_prayer_requests").update(patch).eq("id", id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "invite") {
      const email = String(payload.email || "").toLowerCase().trim();
      const role: Role = payload.role === "admin" ? "admin" : payload.role === "super_admin" ? "super_admin" : "client";
      if (!email || email.indexOf("@") < 1) return json({ error: "A valid email is required." }, 400);
      if ((role === "admin" || role === "super_admin") && !isSuper) return json({ error: "Only a super administrator can invite administrators." }, 403);
      const res = await inviteMember(sb, email, role, caller!.user.id, payload.redirectTo);
      if (res.error) return json({ error: res.error }, 400);
      return json({ ok: true, member: res.member });
    }

    if (action === "set_role") {
      if (!isSuper) return json({ error: "Only a super administrator can change roles." }, 403);
      const uid = String(payload.user_id || "");
      const role: Role = payload.role === "admin" ? "admin" : payload.role === "super_admin" ? "super_admin" : "client";
      if (!uid) return json({ error: "user_id is required." }, 400);
      const target = await getMember(sb, uid);
      if (!target) return json({ error: "That account was not found." }, 404);
      if (target.role === "super_admin" && role !== "super_admin" && target.status === "active" && (await activeSuperCount(sb)) <= 1) {
        return json({ error: "You can't remove the last super administrator. Promote someone else first." }, 409);
      }
      const { data, error } = await sb.from("t3l_portal_members")
        .update({ role, updated_at: new Date().toISOString() }).eq("user_id", uid).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, member: data });
    }

    if (action === "revoke") {
      const uid = String(payload.user_id || "");
      if (!uid) return json({ error: "user_id is required." }, 400);
      const target = await getMember(sb, uid);
      if (!target) return json({ error: "That account was not found." }, 404);
      if (!isSuper && target.role !== "client") return json({ error: "Only a super administrator can revoke an administrator." }, 403);
      if (target.role === "super_admin" && target.status === "active" && (await activeSuperCount(sb)) <= 1) {
        return json({ error: "You can't revoke the last super administrator." }, 409);
      }
      const { error } = await sb.from("t3l_portal_members")
        .update({ status: "revoked", updated_at: new Date().toISOString() }).eq("user_id", uid);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: (e && (e as Error).message) || String(e) }, 500);
  }
});
