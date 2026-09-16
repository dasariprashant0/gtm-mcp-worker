# Setup guide

What has been done, and what is left. Steps 1–3 are complete; steps 4–7 need
someone with access to the Google Cloud and Cloudflare Zero Trust consoles.

---

## 1. Cloudflare — DONE

Worker deployed to the `you@example.com's Account` Cloudflare account:

```
https://gtm-mcp-worker.YOUR-SUBDOMAIN.workers.dev
```

A dedicated KV namespace was created for the OAuth grants — deliberately **not**
shared with `ga4-mcp-worker`, because the grants stored here carry Tag Manager
write scope and the two servers should be revocable independently:

```
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "00000000000000000000000000000000"
```

The Worker is deployed in its safest configuration: `GTM_MODE = "read_only"` and
`GTM_FORCE_DRY_RUN = "true"`. It cannot change anything in Tag Manager until those
are flipped in `wrangler.toml` and redeployed — see step 7.

---

## 2. BLOCKER — Cloudflare Access is in front of every `*.workers.dev` hostname

Every request to the Worker, including the unauthenticated `/health` endpoint, is
intercepted before it reaches the Worker:

```
$ curl -i https://gtm-mcp-worker.YOUR-SUBDOMAIN.workers.dev/health
HTTP/2 302
location: https://prashant-dasari.cloudflareaccess.com/cdn-cgi/access/login/...
www-authenticate: Cloudflare-Access ...
```

**This affects `ga4-mcp-worker` identically** — same Access application (same `kid`),
same 302. Any MCP client connecting over HTTP will be bounced to an Access login
page it cannot complete, so this must be resolved before either server is usable
from Claude.

### The fix

This is Cloudflare's **account-level Workers Access** feature: one policy that makes
every Worker in the account private, current and future. It is *not* an ordinary
Access application, which is why it does not appear under Zero Trust → Access →
Applications. Look in **Workers & Pages** instead.

**Option A — exempt these two Workers (recommended).**
Workers & Pages → select `gtm-mcp-worker` → the **Access** tab → make the Worker
public / bypass account-level Access. Repeat for `ga4-mcp-worker`.

**Option B — narrow the account policy to previews only.**
Workers & Pages overview → the **"Protect all Workers"** card → change the coverage
from **All traffic** to **Previews only**. Preview deployments stay protected;
production `*.workers.dev` hostnames stop redirecting. This is the better option if
nothing else in the account depends on production Access protection.

**Option C — turn it off.** Same card, disable the rule.

Bypassing Access does **not** make these Workers meaningfully public: `/mcp` is still
gated by an OAuth bearer token the Worker itself issues, sign-in still requires a
Google account, and `ALLOWED_EMAIL_DOMAIN` still restricts that to `@example.com`. The
only genuinely public routes are `/` (a plain-text banner) and `/health` (a
configuration summary with no secrets and no Tag Manager data).

This was not changed automatically — it is a security setting on the Cloudflare
account and is yours to decide.

Verify the fix with:

```bash
curl -s https://gtm-mcp-worker.YOUR-SUBDOMAIN.workers.dev/health
```

It should return JSON starting `{"status":"ok"...}`, not an HTML redirect.

---

## 3. Google Cloud — enable the Tag Manager API

In the **same Google Cloud project that owns the GA4 MCP OAuth client**:

**APIs & Services → Library → search "Tag Manager API" → Enable.**

(Worth writing the project ID down in this file once confirmed — the GA4 repo never
recorded it, which is the one thing that would make it hard to hand over.)

---

## 4. Google Cloud — add the Tag Manager scopes to the consent screen

**APIs & Services → OAuth consent screen → Data Access → Add or remove scopes.**

Add exactly these two:

```
https://www.googleapis.com/auth/tagmanager.readonly
https://www.googleapis.com/auth/tagmanager.edit.containers
```

The consent screen is **User type: Internal**, so this needs no Google review and no
verification wait.

> **Do not add** `tagmanager.publish`, `tagmanager.edit.containerversions`,
> `tagmanager.delete.containers`, `tagmanager.manage.users` or
> `tagmanager.manage.accounts`. Their absence is Layer 1 of the safety model: with
> them absent, Google itself refuses any attempt to publish, version, delete a
> container or workspace, or change permissions — no matter what the Worker code
> does. Adding one silently removes that guarantee.

---

## 5. Google Cloud — add the redirect URI

**APIs & Services → Credentials →** the existing GA4 MCP *Web application* OAuth
client **→ Authorised redirect URIs → ADD URI:**

```
https://gtm-mcp-worker.YOUR-SUBDOMAIN.workers.dev/callback
```

Add it **alongside** the GA4 worker's callback; do not replace it. It must go in
*Authorised redirect URIs*, not *Authorized JavaScript origins* — that field rejects
paths. A mismatch shows up as `redirect_uri_mismatch` at sign-in, and the Worker's
error page prints the exact URI it expected.

Optional but tidy: the consent screen's app name currently reads as the GA4 app.
Since it now fronts both, renaming it to something like **"YourCompany Marketing MCP"**
makes the consent dialog less confusing.

---

## 6. Set the secrets

Same two values the GA4 worker uses, from *Credentials → the client*:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Paste each at the interactive prompt. **Never pipe them** — `echo ... | wrangler`
appends a newline to the value and leaves the secret in your shell history.

Confirm with:

```bash
npx wrangler secret list --env=""
```

---

## 7. Connect, then enable writes

```bash
claude mcp add --transport http --scope user gtm https://gtm-mcp-worker.YOUR-SUBDOMAIN.workers.dev/mcp
```

Run `/mcp` in an interactive `claude` session, pick `gtm`, sign in with Google, and
confirm the consent screen lists both Tag Manager permissions.

Prove reads work first: `gtm_list_accounts` → `gtm_list_containers` →
`gtm_list_workspaces` → `gtm_get_version` with `version_id="live"`.

Then enable writes in stages. In `wrangler.toml`:

1. `GTM_MODE = "read_write"`, leaving `GTM_FORCE_DRY_RUN = "true"`. Redeploy.
   Every write now returns the exact request it would have sent, and changes
   nothing. Run through a real editing session this way and read the previews.
2. Once the previews look right, `GTM_FORCE_DRY_RUN = "false"`. Redeploy.
   Individual calls can still pass `dry_run=true`.

```bash
npm run verify && npm run deploy
```

### GTM permissions, per person

The Worker acts as whoever signed in, so access is each individual's own:

- **View** on the container → read tools work, write tools return 403.
- **Edit** or higher on the container → write tools work.

Granted in Tag Manager → **Admin → Container → User Management**. Container-level,
not just account-level. There is no service account, so there is no service-account
email to add anywhere.

---

## Quotas

Tag Manager API quota is **project-wide** and much tighter than GA4's: roughly
10,000 requests/day with a low per-second ceiling, shared across everyone using the
Cloud project. Check current usage and request an increase at **APIs & Services →
Tag Manager API → Quotas**.

The server already economises: lists are summarised by default, `gtm_get_type_reference`
answers type questions with no API call at all, pagination caps at 10 pages, and the
per-session mutation budget caps writes. If 429s start appearing, raise the quota
rather than retrying — the error hint says the same thing to the model.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| HTML 302 to `cloudflareaccess.com` | Step 2 is not done. |
| `redirect_uri_mismatch` at sign-in | Step 5. The error page prints the exact URI to add. |
| "Tag Manager permission was not granted" | The user unticked a scope. Sign in again, leave both ticked. |
| 403 mentioning scopes | An operation this server deliberately cannot do. Use the GTM UI. |
| 403 not mentioning scopes | Either no container permission for that person, or step 3 is not done. |
| `invalid_grant` | Sign-in revoked or expired. Remove and re-add the connector. |
| "Signed in — but this account has no Tag Manager access" | Working as intended. Sign-in succeeded; the person is not in Tag Manager. An admin adds them under Admin › User Management, per container. Nothing needs reconnecting afterwards. |
| Tools return empty lists but sign-in worked | Same cause as above, seen after the fact. `gtm_list_accounts` returning `[]` means no GTM access, not a broken server. |
| Writes refused, citing `GTM_MODE` | Step 7 stage 1. |
| Writes return `dry_run: true` | Step 7 stage 2. |
| "Refusing to write to the Default Workspace" | Working as intended. `gtm_create_workspace` first. |
