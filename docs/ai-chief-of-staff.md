# T3L Portal — AI Chief of Staff integration (planned)

**Status:** intended / not yet wired. This note records the design intent so it
is not lost: the T3L portal is being built so that, at some point, an **AI chief
of staff** (e.g. CORA in the 28FS stack) can operate it alongside — or on behalf
of — the ministry's human administrators.

Nothing in the portal talks to an AI agent today. This document explains why the
current architecture is already shaped for it, what the agent would do, and the
small set of things that still need to be added when we wire it.

## Why the current design is already agent-ready

Every portal feature runs through **one Supabase edge function, `t3l-portal`,
with a single action-based JSON contract**:

```
POST /functions/v1/t3l-portal   { "action": "<verb>", ...payload }
```

- **One clean, enumerable API surface.** Actions are plain verbs — `event_save`,
  `comms_announcement_save`, `comms_email_send`, `resource_save`,
  `list_prayer_requests`, `set_prayer_status`, `crm_list`, `giving_summary`,
  `admin_overview`, etc. An agent can call exactly what a human console button
  calls; there is no second, hidden code path.
- **Service-role mediated.** All privileged work happens inside the edge
  function under the service role. The browser (and, later, the agent) only ever
  sends `{action, payload}` and a bearer token — never a database credential.
- **Role tiers already exist.** `super_admin > admin > client` in
  `t3l_portal_members`, enforced per action. An agent identity slots into this
  model rather than bypassing it.
- **A status read already exists.** `admin_overview` returns live counts (open
  prayer requests, upcoming events, published announcements + resources) plus the
  next few events — exactly the kind of "what needs attention?" digest a chief of
  staff opens with.
- **Everything is on Supabase.** Moving Events, Resources, Announcements, Prayer,
  CRM, Giving, Community and Communications off GoHighLevel and onto Supabase
  means there is a single, queryable source of truth for the agent — no external
  webhook black boxes.

## What the AI chief of staff would do

Reading (safe, no confirmation needed):
- Open-with-a-digest: call `admin_overview` for counts + upcoming events.
- Surface new **prayer requests** needing care (`list_prayer_requests`).
- Summarize **CRM** activity and **giving** (`crm_list`, `giving_summary`).
- Report what's **published** vs. draft across events / announcements / resources.

Acting (drafts and routine writes):
- Draft (and, with a human OK, publish) an **announcement** or **event**.
- Prepare a **resource** entry from a link.
- Move a **CRM** contact's stage, log a note, add a follow-up task.
- Flag a prayer request's status for the care team.

Outward / sensitive (always needs explicit human confirmation):
- Sending an **email broadcast** (`comms_email_send`) — real messages to real
  people.
- Inviting or revoking **members** (`invite`, `revoke`, `set_role`).
- Deleting anything, or flipping a **feature flag** (`set_module`).

## What still needs to be added to wire it (future work)

1. **An agent identity + auth path.** Options, cheapest first:
   - a dedicated `t3l_portal_members` row for the agent with a scoped role, or
   - a signed service token the edge function recognizes as "the chief of staff"
     and maps to a role, with its own allow-list of actions.
   Keep the agent's privileges **≤ a human admin's**; never let it be the last
   super admin.
2. **Guardrails on the agent path.** A hard server-side rule that outward or
   destructive actions (`comms_email_send`, `invite`, `revoke`, `set_role`,
   `set_module`, any `*_delete`) require an explicit human approval token, not
   just the agent's say-so. The human console stays the source of authority.
3. **Audit logging.** Record who (human vs. agent) did what, so agent actions are
   reviewable. (`t3l_comms_email_log` already does this for sends; generalize it.)
4. **An agent-facing digest action (optional).** `admin_overview` covers most of
   it; we may add a richer "daily brief" action that bundles prayer + events +
   giving + CRM deltas in one call.

## Design rules to preserve so this stays easy

- Keep **one action per capability** in `t3l-portal`; don't fork a separate
  "agent API." The agent should call the same verbs the console does.
- Keep every write **validated and role-checked inside the edge function**, so a
  new caller (the agent) inherits the same safety automatically.
- Keep **outbound/destructive actions gated**; the agent proposes, a human
  confirms.
