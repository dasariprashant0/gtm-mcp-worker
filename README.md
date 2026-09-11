# gtm-mcp-worker

A Google Tag Manager MCP server running on Cloudflare Workers. It lets the team
inspect and edit GTM containers from Claude. Each teammate signs in with their own
Google account, so every call acts with exactly their Tag Manager permissions.

Sibling of [`ga4-mcp-worker`](https://github.com/dasariprashant0/ga4-mcp-worker),
and built the same way: same stack, same per-user OAuth, same Cloudflare account,
same Google OAuth client.

- **Deployed at** `https://gtm-mcp-worker.YOUR-SUBDOMAIN.workers.dev`
- **MCP endpoint** `POST /mcp` (Streamable HTTP — there is no `/sse`)
- **27 tools** — 13 read, 14 write

## What it can and cannot do

It can read everything the signed-in user can read, and it can create, update and
delete **tags, triggers, variables and folders inside a workspace**.

It **cannot publish**. It also cannot create or modify a container version, preview,
delete a container or a workspace, manage user permissions, or touch environments.
Changes land in a workspace where a human reviews them in the Tag Manager UI and
publishes if they agree.

That boundary is not a policy note — it is enforced three times over:

| Layer | Where | What it stops |
|---|---|---|
| 1. OAuth scope | [`src/google-oauth.ts`](src/google-oauth.ts) | The server never requests `tagmanager.publish`, `.edit.containerversions`, `.delete.containers`, `.manage.users` or `.manage.accounts`. Google refuses those calls regardless of what this code does. |
| 2. Endpoint allowlist | [`src/gtm/allowlist.ts`](src/gtm/allowlist.ts) | Anchored regexes checked before any socket opens, plus a deny list naming forbidden operations. Catches the things `edit.containers` *would* permit: container create/update/combine, `move_tag_id`, `versions:set_latest`, destinations, environments. |
| 3. Write guardrails | [`src/gtm/safety.ts`](src/gtm/safety.ts) | Read-only mode, dry run, refusal to write to the Default Workspace, delete confirmation with a name check and a reference check, a per-session mutation budget, and an audit log line per mutation. |

Layers 1 and 2 are covered by [`scripts/check-allowlist.ts`](scripts/check-allowlist.ts),
which asserts 39 specific operations are rejected and 34 are allowed. It runs on
every `npm run verify`, before every deploy.

## Connecting

```bash
claude mcp add --transport http --scope user gtm https://gtm-mcp-worker.YOUR-SUBDOMAIN.workers.dev/mcp
```

Then run `/mcp` in an interactive `claude` session, pick `gtm`, and complete the
Google sign-in in your browser. There is no header and no secret to distribute —
teammates need only the URL. Dynamic client registration is on, so clients
self-register on first connect.

Sign-in is restricted to `@example.com` Google accounts, checked server-side against
the `id_token` in `/callback`.

## The tools

### Read (13)

| Tool | What it does |
|---|---|
| `gtm_list_accounts` | Every GTM account you can see. Start here. |
| `gtm_list_containers` | Containers in an account, with numeric and public IDs. |
| `gtm_lookup_container` | Resolve `GTM-`/`G-`/`AW-`/`GT-` to its account and container. |
| `gtm_get_container` | One container in detail. |
| `gtm_get_container_snippet` | The install snippet, for checking against the live site. |
| `gtm_list_workspaces` | Workspaces in a container. |
| `gtm_get_workspace_status` | **The diff.** Uncommitted changes vs the live version, plus merge conflicts. |
| `gtm_list_entities` | Tags / triggers / variables / folders / templates / clients / transformations / zones / gtag config / built-ins. Summarised by default. |
| `gtm_get_entity` | One entity in full, with `fingerprint` and a flattened `_parameters` view. |
| `gtm_find_references` | Everything that references a variable, trigger or tag. Run before deleting or renaming. |
| `gtm_list_versions` | Container version headers. Read-only. |
| `gtm_get_version` | One version in full, or `"live"` for what is published right now. |
| `gtm_get_type_reference` | Offline table of GTM's opaque type codes. Costs no API quota. |

### Write (14)

`gtm_create_workspace`, `gtm_sync_workspace`, `gtm_create_tag`, `gtm_update_tag`,
`gtm_create_trigger`, `gtm_update_trigger`, `gtm_create_variable`,
`gtm_update_variable`, `gtm_create_folder`, `gtm_update_folder`,
`gtm_move_entities_to_folder`, `gtm_set_built_in_variables`, `gtm_delete_entity`,
`gtm_revert_entity`.

Three things about the write tools are worth knowing before you use them.

**Updates merge; they do not replace.** The Tag Manager API's update is a full
replace, so sending `{name, parameter}` to change an event name would silently
strip the tag's triggers, folder and notes. This server reads the entity first,
merges your fields over it, and writes back with the fingerprint from that read.
Pass only what you want to change. If someone edits the entity in the GTM UI
in between, the write fails rather than clobbering them — there is no auto-retry.

**Deletes need three things**: `confirm=true`, an `expected_name` that matches
what is actually there, and no other entity referencing the target (or `force=true`).
The name check is the one that earns its keep — the most likely agent failure is a
stale numeric ID pointing at a different tag than the one under discussion.

**`dry_run=true` shows the exact request** without sending it. All validation,
path building, fingerprint fetching and parameter coercion still run, so a dry run
catches a malformed parameter array just as well as a real call.

## The parameter array

Tags, triggers and variables carry a nested `parameter[]` of
`{type, key, value|list|map}` with eight possible types. It is the single biggest
source of failed GTM writes, so the server works in a **flat representation** in
both directions: `gtm_get_entity` returns `_parameters` as plain key/value pairs,
and every write tool accepts that same flat shape as shorthand.

```jsonc
// These are equivalent:
"parameters": {"value": "G-XXXXXXXXXX"}
"parameters": [{"type": "template", "key": "value", "value": "G-XXXXXXXXXX"}]
```

Shorthand cannot express nesting unambiguously, so lists and maps still need the
explicit form. The tool descriptions carry worked examples for a GA4 event tag and
a Constant variable; `gtm_get_type_reference` has the type codes.

## Configuration

Non-secret vars live in [`wrangler.toml`](wrangler.toml):

| Var | Default | Meaning |
|---|---|---|
| `GTM_MODE` | `read_only` | `read_write` enables writes. Absent or misspelt means read-only — it fails closed. |
| `GTM_FORCE_DRY_RUN` | `true` | Every write returns a preview and changes nothing, whatever the caller passes. |
| `GTM_ALLOW_DEFAULT_WORKSPACE` | `false` | Lifts the refusal to write to a workspace named "Default Workspace". |
| `GTM_MUTATION_BUDGET` | `50` | Max mutations per MCP session. Runaway-loop guard. |
| `ALLOWED_EMAIL_DOMAIN` | `example.com` | Enforced server-side at sign-in. |

Secrets (`wrangler secret put`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Both
are shared with the GA4 worker — rotating one affects both.

## Development

```bash
npm install
npm run verify      # typecheck + allowlist + params checks + bundle dry-run
npm run dev         # local, against the real Tag Manager API
npm run deploy
npm run tail        # live logs
```

`npm run verify` is the gate, and it runs in CI on every push and pull request
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) — a push to `main`
deploys only if it passes, then asserts `/health` comes back ok. So a change that
weakens the safety layer fails CI instead of reaching production. CI needs one
repository secret, `CLOUDFLARE_API_TOKEN`.

Locally it runs `tsc --noEmit`, the allowlist and parameter
self-checks, two source-discipline checks (nothing outside `http.ts` may call
`fetch`; the tool layer may not call the write helpers directly), and a bundle
dry-run. Run it before every deploy.

## Audit trail

Every mutation emits two JSON log lines — `mutation_attempt` before and
`mutation_result` after — carrying the actor's email, the account/container/workspace,
the entity, and the outcome. Dry runs emit `mutation_dry_run`. Workers Logs is
configured with `persist = true`, so these are queryable in the Cloudflare dashboard
rather than only visible live via `wrangler tail`.

## Telemetry

Every tool call writes a row to the **Analytics Engine** dataset `analytics_events`
(binding `analytics_engine`), and every mutation writes a second row carrying what
was touched. Workers Logs answers "what happened in this incident"; this answers
"how many writes last month, by whom, with what error rate".

The schema is **positional** — Analytics Engine has no column names, only
`blob1..blob20` and `double1..double20`. [src/gtm/analytics.ts](src/gtm/analytics.ts)
documents every slot. Only ever append new fields at the end: inserting one in the
middle silently reinterprets all historical rows, and nothing errors.

Nothing from Tag Manager itself is recorded — no tag names, no parameter values, no
container contents. Only which operation ran, on which IDs, by whom. `blob5` does
carry the signed-in user's email, since "who changed this tag" is the point of an
audit trail; swap it for `ctx.sub` in `analytics.ts` if you would rather it did not.

Query it with the SQL API:

```bash
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql" \
  -H "Authorization: Bearer <TOKEN>" \
  --data "SELECT blob3 AS tool, blob4 AS outcome, blob13 AS error_kind, double1 AS ms
          FROM analytics_events FORMAT JSON"
```

Useful ones:

| Question | Query |
|---|---|
| Error rate per tool | `SELECT blob3, AVG(double2) FROM analytics_events GROUP BY blob3` |
| Writes that actually applied | `SELECT count() FROM analytics_events WHERE blob2='mutation' AND blob12='false'` |
| Who is using it | `SELECT blob5, count() FROM analytics_events GROUP BY blob5` |
| Quota pressure | `SELECT count() FROM analytics_events WHERE blob13='quota'` |
| Guardrails firing | `SELECT blob13, count() FROM analytics_events WHERE blob4='error' GROUP BY blob13` |

That last one is the interesting one: `blocked_by_allowlist`, `read_only_mode`,
`default_workspace_refused`, `delete_unconfirmed` and `references_exist` all mean a
safety layer did its job, and are worth watching rather than treating as noise.

## Quotas

The Tag Manager API quota is **project-wide**, not per-container, and much tighter
than GA4's — on the order of 10,000 requests per day with a low per-second ceiling,
shared by everyone using this server and the Cloud project. That is why lists are
summarised by default, why pagination caps at 10 pages, and why the mutation budget
exists. See [SETUP-GUIDE.md](SETUP-GUIDE.md) for requesting an increase.

## Not implemented

Custom templates, clients, transformations and zones are **readable but not
writable**: templates inject sandboxed JavaScript into the container, and the rest
are server-container resources where the shapes are stranger and a wrong write is
expensive. The allowlist would need a new entry to enable any of them, which is the
point. Do those in the Tag Manager UI.
