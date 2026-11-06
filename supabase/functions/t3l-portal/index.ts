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
         "crm_list", "crm_get", "crm_save", "crm_activity", "crm_archive",
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

    if (action === "crm_get") {
      const id = String(payload.id || ""); if (!id) return json({ error: "id is required." }, 400);
      const { data: contact } = await sb.from("t3l_crm_contacts").select("*").eq("id", id).maybeSingle();
      if (!contact) return json({ error: "That contact was not found." }, 404);
      const { data: activities } = await sb.from("t3l_crm_activities")
        .select("id,kind,body,created_at").eq("contact_id", id).order("created_at", { ascending: false });
      return json({ contact, activities: activities || [] });
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
      const rowg: Record<string, unknown> = {
        contact_id: payload.contact_id ? String(payload.contact_id) : null,
        donor_name: String(payload.donor_name || "").trim() || null,
        donor_email: String(payload.donor_email || "").trim() || null,
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
        return json({ ok: true, gift: data });
      }
      rowg.created_by = caller!.user.id;
      const { data, error } = await sb.from("t3l_giving_gifts").insert(rowg).select().maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, gift: data });
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
