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

type Role = "client" | "admin" | "super_admin";

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

      if (action === "community_feed") {
        const { data } = await sb.from("t3l_community_posts")
          .select("id,author_user_id,author_name,body,pinned,created_at")
          .eq("hidden", false).order("pinned", { ascending: false }).order("created_at", { ascending: false }).limit(60);
        const posts = (data || []).map((p: any) => ({
          id: p.id, author_name: p.author_name, body: p.body, pinned: p.pinned,
          created_at: p.created_at, mine: p.author_user_id === uid,
        }));
        return json({ posts });
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
         "list_prayer_requests", "set_prayer_status", "get_modules", "set_module",
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
    if (action === "get_modules") {
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
        .select("id,name,email,ministry_role,request,status,internal_note,created_at")
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
