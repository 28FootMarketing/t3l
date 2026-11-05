# T3L Portals — Client & Admin

Two member portals with **real sign-in** (Supabase Auth, passwordless magic
link), **invite-only** accounts, and a **server-enforced admin gate**.

| File | What it is |
| --- | --- |
| `login.html` | Passwordless sign-in. Emails a magic link, then routes by role. |
| `client.html` | Member-facing client portal. Hidden until a valid member session is confirmed. |
| `admin.html` | **Loader only.** Fetches the admin UI from the server; the markup is delivered **only** to a verified admin session. |
| `auth.js` | Shared Supabase config + helpers (public anon key only). |
| `flags.json` | The CORA on/off toggle reference `{ "client": true, "admin": true }`. |

The admin interface markup itself lives server-side in the `t3l-portal` edge
function (`supabase/functions/t3l-portal/`), not in the deployed site, so a
visitor without an admin session never receives it.

## How authentication works

1. A member opens `client.html` (or `admin.html`). With no session they are sent
   to `login.html`.
2. They enter their email and receive a **magic link** (no password). Accounts
   are **invite-only** — `login.html` uses `shouldCreateUser:false`, so unknown
   emails cannot self-register.
3. After the link, the session is established and they are routed by role:
   `admin` → `admin.html`, member → `client.html`.
4. `admin.html` asks the `t3l-portal` edge function (`action:"app"`) for the
   admin UI. The function verifies the JWT **and** that the caller is an active
   `admin` in `public.t3l_portal_members`. Non-admins get `403` and never
   receive the markup.

### Role tiers

`super_admin` > `admin` > `client`, stored in
`public.t3l_portal_members (user_id, email, role, status, …)`:

- **super_admin** — full control, including creating/promoting/removing admins
  and other super admins (the last active super admin is protected and can't be
  removed). Manages everyone from the admin portal's **People & access** screen.
- **admin** — manages content and client members; can invite/revoke *clients*
  only, and cannot touch admin or super-admin accounts.
- **client** — member access to the client portal.

RLS: a user can read only their own row; an admin or super admin can read all.
**All writes go through the edge function (service role) only** — the browser
never holds a privileged key, and role changes are enforced super-admin-only
server-side.

## Backend (Supabase project `neptxzpueslyzfgaktez`)

- **Migration:** `supabase/migrations/0001_t3l_portal_auth.sql`
- **Edge function:** `supabase/functions/t3l-portal/index.ts` (gate + member
  management). Deploy with `verify_jwt = false` (it verifies JWTs itself so it
  can also serve the public `status`/`bootstrap` actions).
- **Server secret:** `T3L_FIRST_ADMIN_EMAIL` — the one email allowed to
  bootstrap the first admin.

Edge-function actions: `status`, `bootstrap`, `me`, `app`, `invite`,
`list_members`, `set_role`, `revoke`.

## One-time setup checklist (must be done in the Supabase dashboard)

1. **Apply the migration** (`supabase/migrations/0001_t3l_portal_auth.sql`) and
   **deploy** `supabase/functions/t3l-portal` with `verify_jwt = false`.
2. **Set the function secret** `T3L_FIRST_ADMIN_EMAIL` to the ministry’s
   **super administrator** email (bootstraps the first super admin).
3. **Auth → Providers → Email:** enable **Email** with **magic link** on.
4. **Auth → URL Configuration:** set **Site URL** to `https://t3loutreach.org`
   and add **Redirect URLs**: `https://t3loutreach.org/portals/login.html`,
   `https://www.t3loutreach.org/portals/login.html`, and your
   `*.vercel.app` preview URL if used.
5. **(Recommended) SMTP:** configure a custom SMTP sender (Auth → Emails) so
   invite / magic-link emails deliver reliably; the default sender is heavily
   rate-limited.
6. **Create the first super admin:** open `login.html` → **First-time setup** →
   *Send administrator setup link* (goes to `T3L_FIRST_ADMIN_EMAIL`). Open the
   emailed link to finish. After that, invite and manage everyone else from the
   admin portal’s **People & access** screen. Keep **“Allow new users to sign
   up” enabled** at the project level (invite-only is enforced in the app), *or*
   pre-create users via invite.

## The CORA on/off toggle (unchanged)

The client portal and the admin UI still carry the CORA on/off toggle, resolved
on load (first decisive source wins): `?portal=off|on` → `localStorage`
(`t3l:portal:client` / `t3l:portal:admin`) → remote flags
(`https://mgtmqucaldkaxvxglguw.supabase.co/functions/v1/t3l-portal-flags`) →
default on. Flip it from CORA by Telegram (`portal admin off`, `portal client on`,
`portal all off`, `portal status`) or by SQL on the **28 Foot Systems** project:

```sql
update public.t3l_portal_flags set enabled = false, updated_at = now() where key = 'admin';
```

The toggle takes a portal **offline** for everyone; authentication controls **who
can sign in** when it is online. They are independent controls.
