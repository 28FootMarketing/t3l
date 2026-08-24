# T3L Portals — Client & Admin

Two self-contained GoHighLevel portal pages, each with a built-in **on/off
toggle** so you can take a portal offline without editing the app or redeploying.

| File | What it is |
| --- | --- |
| `client.html` | Member-facing client portal (home, events calendar, prayer request form). |
| `admin.html` | **Admin-only** portal (announcements, events, resources, prayer-status). Keep it behind private access — never link it publicly. |
| `flags.json` | The on/off switch your platform (CORA) controls: `{ "client": true, "admin": true }`. |

Each portal keeps its original GoHighLevel webhook wiring (prayer form, admin
actions). See the notes at the top of each HTML file and the original vendor
docs for webhook setup — this README only covers the toggle.

## The on/off toggle

Each portal resolves its enabled state on load, first decisive source wins:

1. **URL param** — `?portal=off` or `?portal=on`. Quick manual test; nothing saved.
2. **localStorage** — `t3l:portal:client` / `t3l:portal:admin` set to `'off'` or `'on'`. Per-browser.
3. **Remote flags JSON** — the `REMOTE_FLAGS_URL` constant in each file, pointed at a JSON like `flags.json`. **This is the CORA hook.**
4. **Default** — `DEFAULT_ENABLED = true` in each file.

When a portal is off, its app is hidden and a branded "This portal is currently
offline" notice shows instead, with the T3L phone number and a link home.

### Flip it from CORA

`REMOTE_FLAGS_URL` is already wired to this site's own **`/portals/flags.json`**
(same origin — no CORS setup needed). To take a portal offline, have CORA edit
that file and set the key to `false`:

```json
{ "client": true, "admin": false }
```

Viewers loading the portal next get the offline notice; set it back to `true` to
restore. Because the file is served by the site, a change takes effect on the
**next deploy** (CORA commits `flags.json` → the host rebuilds). A missing key
or fetch error falls back to `DEFAULT_ENABLED` (on).

Want instant flips with no deploy? Point `REMOTE_FLAGS_URL` (in both
`client.html` and `admin.html`, and in the GoHighLevel embed copy if you embed
there) at a live endpoint CORA updates directly — a Supabase Storage object,
an edge function, or a Vercel route — returning the same JSON shape with
permissive CORS for the site origin.

A missing key or a fetch error falls back to `DEFAULT_ENABLED` (on), so a flags
outage never hard-breaks the portal.

### Flip it without a backend

- **This browser:** open the browser console on the portal and run
  `localStorage.setItem('t3l:portal:client','off')` (or `'admin'`), reload.
  `'on'` re-enables; `removeItem(...)` returns to default/remote.
- **A shareable link:** `…/portals/client.html?portal=off` shows the offline
  state for anyone who opens that link (not persisted).
- **In code:** flip `DEFAULT_ENABLED` to `false` in the file and redeploy.

## Using in GoHighLevel

Same as the vendor instructions: paste the `<style>`, then the `<body>`
contents, then the trailing `<script>` blocks into a Custom HTML element. The
toggle lives in the final `<script>`, so it carries into the embed — `?portal=`
won't apply inside GHL, but `localStorage` and `REMOTE_FLAGS_URL` both do.

> The admin portal is a static interface, not authentication. Put it on a
> private, membership-restricted GoHighLevel page and keep its URL out of public
> and client navigation.
