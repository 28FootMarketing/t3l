/* ============================================================================
   T3L Portal — shared Supabase auth helper
   ----------------------------------------------------------------------------
   Real authentication for the client & admin portals:
     - Passwordless magic-link login (Supabase Auth OTP).
     - Invite / admin-created accounts only (shouldCreateUser:false on login;
       accounts are created by an admin through the t3l-portal edge function).
     - Roles live in public.t3l_portal_members (client | admin).
     - The ADMIN portal markup is served only by the edge function to a verified
       admin session — it is never shipped as a static file.

   These values are PUBLIC by design (anon/publishable key + project URL). The
   secret (service role) lives only inside the Supabase edge function.
   ========================================================================== */
(function (global) {
  'use strict';

  var T3L_AUTH = {
    SUPABASE_URL: 'https://neptxzpueslyzfgaktez.supabase.co',
    // Supabase publishable (anon) key — safe to expose in the browser.
    SUPABASE_ANON_KEY: 'sb_publishable_Adg1vXigvY2GMP7BTVSS_A_-PvX3Eb_',
    FN_URL: 'https://neptxzpueslyzfgaktez.supabase.co/functions/v1/t3l-portal',
    LOGIN_PATH: '/portals/login.html',
    CLIENT_PATH: '/portals/client.html',
    ADMIN_PATH: '/portals/admin.html'
  };

  var _client = null;

  // Create (once) a supabase-js client. Requires the supabase-js UMD bundle to
  // be loaded first (window.supabase.createClient).
  T3L_AUTH.client = function () {
    if (_client) return _client;
    if (!global.supabase || !global.supabase.createClient) {
      throw new Error('supabase-js is not loaded');
    }
    _client = global.supabase.createClient(
      T3L_AUTH.SUPABASE_URL,
      T3L_AUTH.SUPABASE_ANON_KEY,
      { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
    );
    return _client;
  };

  // Call the t3l-portal edge function. Attaches the current access token when
  // a session exists so the server can verify the caller.
  T3L_AUTH.callFn = async function (action, payload) {
    var headers = {
      'Content-Type': 'application/json',
      'apikey': T3L_AUTH.SUPABASE_ANON_KEY
    };
    try {
      var sess = await T3L_AUTH.client().auth.getSession();
      var token = sess && sess.data && sess.data.session && sess.data.session.access_token;
      if (token) headers['Authorization'] = 'Bearer ' + token;
    } catch (e) { /* unauthenticated call */ }

    var res = await fetch(T3L_AUTH.FN_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data: data };
  };

  // Resolve the signed-in member (role/status) or null.
  T3L_AUTH.me = async function () {
    var r = await T3L_AUTH.callFn('me', {});
    return r.ok && r.data ? r.data.member : null;
  };

  T3L_AUTH.signOut = async function () {
    try { await T3L_AUTH.client().auth.signOut(); } catch (e) {}
    location.href = T3L_AUTH.LOGIN_PATH;
  };

  global.T3L_AUTH = T3L_AUTH;
})(window);
