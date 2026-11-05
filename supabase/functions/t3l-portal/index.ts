// ============================================================================
// t3l-portal — T3L portal authentication gate + member management
// ----------------------------------------------------------------------------
// Supabase project neptxzpueslyzfgaktez. Deploy with verify_jwt = false: this
// function verifies the caller's JWT itself so it can also serve the public
// `status`/`bootstrap` actions. All privileged work uses the service role,
// which stays inside this function and never reaches the browser.
//
// Role tiers: super_admin > admin > client
//
// Actions (POST JSON { action, ... }):
//   status        -> { setup_needed }                         (public)
//   bootstrap     -> creates the first SUPER admin            (public, one-time)
//   me            -> { member|null }                          (any signed-in user)
//   app           -> { html }  admin console, admin/super     (403 otherwise)
//   invite        -> create member + send link                (admin/super)
//   list_members  -> { members }                              (admin/super)
//   set_role      -> change a member's role                   (super only)
//   revoke        -> revoke a member                          (admin: clients; super: anyone)
//
// The admin console markup is embedded below and returned ONLY to a verified
// admin/super session.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FIRST_ADMIN_EMAIL = (Deno.env.get("T3L_FIRST_ADMIN_EMAIL") || "").toLowerCase().trim();

type Role = "client" | "admin" | "super_admin";

const ADMIN_APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#311536">
<title>Administrator · Teach Them to Love</title>
<link rel="icon" href="/assets/img/t3l-logo.png" type="image/png">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap');
:root{--plum:#4a214f;--plum-deep:#311536;--gold:#d8ad5b;--gold-deep:#967027;--ink:#2b2030;--cream:#f8f5ef;--paper:#fffdfa;--muted:#746a72;--line:#e9ded2;--danger:#a04c43;--success:#2d6642}
*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font-family:'DM Sans',Arial,sans-serif;line-height:1.5}
.topbar{display:flex;align-items:center;gap:14px;padding:16px 26px;background:linear-gradient(135deg,#311536,#4e2452);color:#fff;position:sticky;top:0;z-index:10}
.logo{width:38px;height:38px;border-radius:50%;clip-path:circle(50%);object-fit:cover;flex:0 0 38px}
.brand{font-family:'Playfair Display',Georgia,serif;font-weight:700;font-size:17px;line-height:1}
.sub{color:#ecd69d;font-size:10px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;margin-top:3px}
.spacer{flex:1}
.who{font-size:12px;color:rgba(255,255,255,.82);max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.signout{border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;border-radius:999px;padding:8px 15px;font:700 12px/1 'DM Sans';cursor:pointer}
.signout:hover{background:rgba(255,255,255,.12)}
.wrap{max-width:1040px;margin:0 auto;padding:30px 22px 60px}
.hero{background:linear-gradient(135deg,#3a1a40,#55265a);color:#fff;border-radius:20px;padding:30px 32px;box-shadow:0 18px 45px rgba(53,24,58,.14)}
.hero .eyebrow{color:#ecd69d;font-size:11px;font-weight:700;letter-spacing:.17em;text-transform:uppercase;margin:0 0 8px}
.hero h1{font-family:'Playfair Display',Georgia,serif;font-size:28px;margin:0 0 6px}
.hero p{margin:0;color:rgba(255,255,255,.82);font-size:14px;max-width:62ch}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,.82fr);gap:18px;margin-top:22px}
@media(max-width:820px){.grid{grid-template-columns:1fr}}
.card{background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:0 7px 23px rgba(53,24,58,.04)}
.card .hd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:18px 22px;border-bottom:1px solid var(--line)}
.card .hd h2{margin:0;font:600 19px/1.2 'Playfair Display',Georgia,serif;color:#3b1b40}
.card .hd span{color:#82747c;font-size:11px}
.card .bd{padding:22px}
label{display:block;margin-bottom:6px;color:var(--plum);font-size:13px;font-weight:700}
input,select{width:100%;border:1px solid #dfd3c6;border-radius:10px;padding:11px 12px;background:#fffdfa;color:var(--ink);font:inherit;outline:0}
input:focus,select:focus{border-color:#b7893a;box-shadow:0 0 0 3px rgba(183,137,58,.17)}
.field{margin-bottom:14px}
.btn{border:0;border-radius:999px;padding:12px 18px;background:var(--plum);color:#fff;font:700 13px/1 'DM Sans';cursor:pointer}
.btn:hover{background:#35183a}.btn[disabled]{opacity:.6;cursor:default}
.btn.ghost{background:#fff;color:#65416a;border:1px solid #dfd3c6}
.status{display:none;margin-top:12px;border-radius:10px;padding:10px 12px;font-size:13px}
.status.ok{display:block;background:#e4f1e8;color:var(--success)}.status.err{display:block;background:#f7e5e1;color:#9b4538}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:11px 8px;border-top:1px solid #efe6da;vertical-align:middle}
.pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700}
.note{color:var(--muted);font-size:13px;margin:0 0 16px}
.revoke{border:0;background:transparent;color:var(--danger);font-weight:700;font-size:12px;cursor:pointer}
.rolesel{border:1px solid #dfd3c6;border-radius:8px;padding:6px 8px;font-size:12px}
.zero{padding:30px 10px;text-align:center;color:var(--muted);font-size:13px}
.zero strong{display:block;margin-bottom:4px;color:#3b1b40;font:600 18px/1.2 'Playfair Display',Georgia,serif}
.foot{margin-top:30px;text-align:center;color:#9a8c91;font-size:11px}
</style></head>
<body>
<header class="topbar">
  <img class="logo" src="/assets/img/t3l-logo.png" alt="">
  <div><div class="brand">Teach Them to Love</div><div class="sub">Administrator</div></div>
  <div class="spacer"></div>
  <div class="who" id="who">Administrator</div>
  <button class="signout" id="signout" type="button">Sign out</button>
</header>
<div class="wrap">
  <section class="hero">
    <p class="eyebrow">Administrator portal</p>
    <h1>Welcome back.</h1>
    <p>Manage who can sign in to the Teach Them to Love portals. Accounts are invitation-only — invited people receive a secure sign-in link by email (no passwords).</p>
  </section>
  <div class="grid">
    <article class="card">
      <div class="hd"><h2>People &amp; access</h2><button class="btn ghost" id="refresh" type="button" style="padding:8px 14px">Refresh</button></div>
      <div class="bd" id="peopleList"><div class="zero"><strong>Loading…</strong>Fetching the current roster.</div></div>
    </article>
    <aside class="card">
      <div class="hd"><h2>Invite someone</h2></div>
      <div class="bd">
        <p class="note">They’ll get an email with a secure link to finish signing in.</p>
        <form id="inviteForm">
          <div class="field"><label for="inviteEmail">Email address</label><input id="inviteEmail" type="email" autocomplete="off" placeholder="name@example.com" required></div>
          <div class="field" id="roleField"><label for="inviteRole">Role</label><select id="inviteRole">
            <option value="client">Client (member)</option>
            <option value="admin">Administrator</option>
            <option value="super_admin">Super administrator</option>
          </select></div>
          <button class="btn" type="submit">Send invitation</button>
          <div class="status" id="inviteStatus" role="status" aria-live="polite"></div>
        </form>
      </div>
    </aside>
  </div>
  <p class="foot">Teach Them to Love Outreach Ministries · Administrator portal</p>
</div>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
<script src="/portals/auth.js"></script>
<script>
(function(){
  var viewer=null;
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function isSuper(){return !!(viewer&&viewer.role==='super_admin'&&viewer.status==='active');}
  function roleLabel(r){return r==='super_admin'?'Super admin':r==='admin'?'Administrator':'Client';}
  function pill(r){var s=r==='super_admin'?'background:#efe3f0;color:#5d2b62':r==='admin'?'background:#f6eedb;color:#936a21':'background:#e2efeb;color:#286d63';return '<span class="pill" style="'+s+'">'+roleLabel(r)+'</span>';}
  function setRoles(){var sel=document.getElementById('inviteRole');if(sel&&!isSuper())sel.innerHTML='<option value="client">Client (member)</option>';}
  function render(members){
    var host=document.getElementById('peopleList');
    if(!members.length){host.innerHTML='<div class="zero"><strong>No one yet</strong>Invite your first member or administrator.</div>';return;}
    var rows=members.map(function(m){
      var ctrl='';
      if(isSuper()){
        var opts=['client','admin','super_admin'].map(function(r){return '<option value="'+r+'"'+(m.role===r?' selected':'')+'>'+roleLabel(r)+'</option>';}).join('');
        ctrl+='<select class="rolesel" data-uid="'+esc(m.user_id)+'">'+opts+'</select>';
        if(m.status!=='revoked')ctrl+=' <button class="revoke" data-uid="'+esc(m.user_id)+'">Revoke</button>';
      }else if(m.role==='client'&&m.status!=='revoked'){
        ctrl+='<button class="revoke" data-uid="'+esc(m.user_id)+'">Revoke</button>';
      }
      var rv=m.status==='revoked'?' <span style="color:#a04c43;font-size:11px;font-weight:700">(revoked)</span>':'';
      return '<tr><td>'+esc(m.email)+rv+'</td><td style="white-space:nowrap">'+pill(m.role)+'</td><td style="text-align:right;white-space:nowrap">'+ctrl+'</td></tr>';
    }).join('');
    host.innerHTML='<table><tbody>'+rows+'</tbody></table>';
    host.querySelectorAll('.rolesel').forEach(function(sel){sel.addEventListener('change',async function(){sel.disabled=true;var r=await T3L_AUTH.callFn('set_role',{user_id:sel.dataset.uid,role:sel.value});sel.disabled=false;if(!r.ok)alert((r.data&&r.data.error)||'Could not change the role.');load();});});
    host.querySelectorAll('.revoke').forEach(function(b){b.addEventListener('click',async function(){if(!confirm('Revoke portal access for this account?'))return;b.disabled=true;var r=await T3L_AUTH.callFn('revoke',{user_id:b.dataset.uid});if(!r.ok)alert((r.data&&r.data.error)||'Could not revoke access.');load();});});
  }
  async function load(){var r=await T3L_AUTH.callFn('list_members',{});if(r.ok&&r.data)render(r.data.members||[]);else document.getElementById('peopleList').innerHTML='<div class="zero"><strong>Could not load</strong>Please refresh and try again.</div>';}
  function init(){
    var sb;try{sb=T3L_AUTH.client();}catch(e){location.href=T3L_AUTH.LOGIN_PATH;return;}
    sb.auth.getSession().then(function(s){var sess=s.data&&s.data.session;if(!sess){location.href=T3L_AUTH.LOGIN_PATH;return;}var w=document.getElementById('who');if(w&&sess.user&&sess.user.email)w.textContent=sess.user.email;});
    document.getElementById('signout').addEventListener('click',function(){T3L_AUTH.signOut();});
    document.getElementById('refresh').addEventListener('click',load);
    var form=document.getElementById('inviteForm');
    form.addEventListener('submit',async function(e){e.preventDefault();
      var email=document.getElementById('inviteEmail').value.trim();var roleEl=document.getElementById('inviteRole');var role=roleEl?roleEl.value:'client';
      var st=document.getElementById('inviteStatus');var btn=form.querySelector('button[type=submit]');st.className='status';btn.disabled=true;
      var r=await T3L_AUTH.callFn('invite',{email:email,role:role,redirectTo:location.origin+T3L_AUTH.LOGIN_PATH});btn.disabled=false;
      if(r.ok&&r.data&&r.data.ok){st.textContent='Invitation sent to '+email+'.';st.className='status ok';form.reset();load();}
      else{st.textContent=(r.data&&r.data.error)||'Could not send the invitation.';st.className='status err';}
    });
    (async function(){try{viewer=await T3L_AUTH.me();}catch(e){}setRoles();load();})();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
</script>
</body></html>`;

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
  let payload: any = {};
  try { payload = await req.json(); } catch { payload = {}; }
  const action = String(payload.action || "");
  const sb = svc();

  try {
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

    if (action === "app") {
      if (!caller) return json({ error: "unauthorized" }, 401);
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      return json({ html: ADMIN_APP_HTML });
    }

    if (action === "invite" || action === "list_members" || action === "set_role" || action === "revoke") {
      if (!caller) return json({ error: "unauthorized" }, 401);
      if (!isAdmin) return json({ error: "forbidden" }, 403);
    }

    if (action === "list_members") {
      const { data } = await sb.from("t3l_portal_members")
        .select("user_id,email,role,full_name,status,created_at").order("created_at", { ascending: true });
      return json({ members: data || [] });
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
