/**
 * Self-check for src/gtm/allowlist.ts.
 *
 * A regression here is the failure that matters most in this repo: it is the
 * difference between "the agent edited a tag" and "the agent published to
 * production" or "the agent deleted the container". So this runs as part of
 * `npm run verify`, before every deploy.
 *
 * Run directly — Node strips the TypeScript types natively:
 *     node scripts/check-allowlist.ts
 */

import { assertAllowed, type HttpMethod } from "../src/gtm/allowlist.ts";

const B = "https://tagmanager.googleapis.com/tagmanager/v2";
const A = `${B}/accounts/6012345678`;
const C = `${A}/containers/187654321`;
const W = `${C}/workspaces/7`;

type Case = [HttpMethod, string, string];

/** Must be REJECTED. Each line is a capability this server must not have. */
const MUST_REJECT: Case[] = [
  ["POST", `${W}:create_version`, "create a container version"],
  ["POST", `${C}/versions/45:publish`, "publish a version"],
  ["POST", `${C}/versions/45:set_latest`, "change which version is latest"],
  ["POST", `${C}/versions/45:undelete`, "undelete a version"],
  ["POST", `${W}:quick_preview`, "quick preview (creates a version)"],
  ["POST", `${C}:combine`, "combine containers"],
  ["POST", `${C}:move_tag_id`, "move a tag ID between containers"],
  ["DELETE", C, "delete the container"],
  ["DELETE", W, "delete a workspace (destroys unpublished human work)"],
  ["DELETE", `${C}/versions/45`, "delete a version"],
  ["DELETE", `${A}/user_permissions/9`, "remove a user's access"],
  ["POST", `${A}/user_permissions`, "grant a user access"],
  ["GET", `${A}/user_permissions`, "enumerate who has access"],
  ["PUT", `${A}/user_permissions/9`, "change a user's access"],
  ["PUT", C, "rename/reconfigure the container"],
  ["PUT", A, "rename the account"],
  ["POST", `${A}/containers`, "create a container"],
  ["PUT", `${C}/versions/45`, "edit a version"],
  ["POST", `${C}/environments`, "create a deploy environment"],
  ["POST", `${C}/environments/3:reauthorize`, "reauthorize an environment"],
  ["POST", `${A}/destinations:link`, "link a destination"],
  ["POST", `${W}/templates`, "create a custom template (sandboxed JS)"],
  ["PUT", `${W}/templates/5`, "edit a custom template"],
  ["DELETE", `${W}/templates/5`, "delete a custom template"],
  ["POST", `${W}/templates:import_from_gallery`, "import a gallery template"],
  ["DELETE", `${W}/clients/5`, "delete a server-container client"],
  ["PUT", `${W}/zones/5`, "edit a zone"],
  ["POST", `${W}/bulk_update`, "bulk update"],
  ["POST", `${W}:resolve_conflict`, "resolve a merge conflict"],
  // Path-smuggling and shape attacks.
  ["GET", `${B}/accounts/6012345678/containers/../../accounts`, "path traversal"],
  ["POST", `${C}/workspaces/7abc/tags`, "non-numeric workspace id"],
  ["POST", `${W}/tags/../../../versions/45:publish`, "traversal into publish"],
  ["GET", "https://tagmanagerXgoogleapis.com/tagmanager/v2/accounts", "lookalike host"],
  ["GET", "http://tagmanager.googleapis.com/tagmanager/v2/accounts", "plaintext http"],
  ["GET", `${B}/accounts.evil.com/`, "hostname suffix smuggling"],
  ["PUT", `${W}/tags/42?alt=media&fingerprint=x`, "extra query param on update"],
  ["POST", `${W}/tags?fingerprint=x`, "query string on create"],
  ["DELETE", `${W}/tags/42?force=true`, "query string on delete"],
  ["POST", `${W}/built_in_variables?type=PAGE_URL&evil=1`, "extra param on built-ins"],
];

/** Must be ACCEPTED. These are the capabilities the server is supposed to have. */
const MUST_ACCEPT: Case[] = [
  ["GET", `${B}/accounts`, "list accounts"],
  ["GET", `${A}/containers`, "list containers"],
  ["GET", `${A}/containers?pageSize=50`, "list containers, paginated"],
  ["GET", C, "get a container"],
  ["GET", `${C}:snippet`, "get the install snippet"],
  ["GET", `${B}/accounts/containers:lookup?destination_id=GTM-XXXXXXX`, "lookup by public id"],
  ["GET", `${C}/workspaces`, "list workspaces"],
  ["GET", W, "get a workspace"],
  ["GET", `${W}/status`, "the workspace diff vs live"],
  ["GET", `${W}/tags`, "list tags"],
  ["GET", `${W}/tags/42`, "get a tag"],
  ["GET", `${W}/gtag_config`, "list gtag config"],
  ["GET", `${W}/built_in_variables`, "list built-in variables"],
  ["GET", `${C}/version_headers`, "list versions"],
  ["GET", `${C}/version_headers:latest`, "latest version header"],
  ["GET", `${C}/versions:live`, "the live version"],
  ["GET", `${C}/versions/45`, "get a version"],
  ["POST", `${C}/workspaces`, "create a workspace"],
  ["POST", `${W}/tags`, "create a tag"],
  ["POST", `${W}/triggers`, "create a trigger"],
  ["POST", `${W}/variables`, "create a variable"],
  ["POST", `${W}/folders`, "create a folder"],
  ["PUT", `${W}/tags/42`, "update a tag"],
  ["PUT", `${W}/tags/42?fingerprint=abc123`, "update a tag with fingerprint"],
  ["PUT", `${W}/variables/9?fingerprint=a.b-c~d`, "update a variable"],
  ["DELETE", `${W}/tags/42`, "delete a tag"],
  ["DELETE", `${W}/folders/3`, "delete a folder"],
  ["POST", `${W}/tags/42:revert`, "revert a tag"],
  ["POST", `${W}/built_in_variables?type=PAGE_URL&type=CLICK_TEXT`, "enable built-ins"],
  ["DELETE", `${W}/built_in_variables?type=PAGE_URL`, "disable a built-in"],
  ["POST", `${W}/built_in_variables:revert?type=PAGE_URL`, "revert a built-in"],
  ["POST", `${W}/folders/3:move_entities_to_folder?tagId=1&variableId=2`, "move into folder"],
  ["POST", `${W}/folders/3:entities`, "list folder contents"],
  ["POST", `${W}:sync`, "sync a stale workspace"],
];

let failures = 0;

for (const [method, url, why] of MUST_REJECT) {
  let threw = false;
  try {
    assertAllowed(url, method);
  } catch {
    threw = true;
  }
  if (!threw) {
    failures++;
    console.error(`FAIL  expected REJECT but allowed: ${method} ${url}\n      (${why})`);
  }
}

for (const [method, url, why] of MUST_ACCEPT) {
  try {
    assertAllowed(url, method);
  } catch (err) {
    failures++;
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.error(`FAIL  expected ACCEPT but blocked: ${method} ${url}\n      (${why})\n      ${msg}`);
  }
}

const total = MUST_REJECT.length + MUST_ACCEPT.length;
if (failures > 0) {
  console.error(`\nallowlist check: ${failures}/${total} FAILED`);
  process.exit(1);
}
console.log(
  `allowlist check: ${total}/${total} passed ` +
    `(${MUST_REJECT.length} must-reject, ${MUST_ACCEPT.length} must-accept)`,
);

// ===========================================================================
// Source discipline
// ===========================================================================
//
// Two invariants that regexes cannot express and code review forgets:
//   1. Nothing under src/gtm/ calls fetch() except http.ts. If it did, it
//      would bypass assertAllowed entirely.
//   2. The tool layer never calls gtmPost/gtmPut/gtmDelete directly. Every
//      mutation must go through mutate() in safety.ts, which is where the
//      mode check, the budget, the Default-Workspace refusal and the audit
//      log live.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

let discipline = 0;
const FETCH_ALLOWED = new Set(["src/gtm/http.ts", "src/google-oauth.ts"]);
const WRITE_HELPERS = /\b(gtmPost|gtmPut|gtmDelete)\b/;

for (const file of walk("src")) {
  const rel = file.replace(/\\/g, "/");
  const src = readFileSync(file, "utf8");
  // Strip comments so prose about fetch() doesn't trip the check.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    // `async fetch(request, env, ctx)` is the Worker's own inbound handler, not
    // an outbound call. Neutralise it before looking for real fetch() calls.
    .replace(/\basync\s+fetch\s*\(/g, "inboundHandler(");

  if (/(?<![\w.])fetch\s*\(/.test(code) && !FETCH_ALLOWED.has(rel)) {
    discipline++;
    console.error(
      `FAIL  ${rel} calls fetch() directly. Only ${[...FETCH_ALLOWED].join(" and ")} may — ` +
        `everything else must go through the helpers in src/gtm/http.ts so assertAllowed runs.`,
    );
  }

  if (rel.startsWith("src/gtm/tools/") && WRITE_HELPERS.test(code)) {
    discipline++;
    console.error(
      `FAIL  ${rel} references gtmPost/gtmPut/gtmDelete. The tool layer must route every ` +
        `mutation through mutate() in src/gtm/safety.ts, which enforces GTM_MODE, the mutation ` +
        `budget, the Default-Workspace refusal, dry-run and the audit log.`,
    );
  }
}

if (discipline > 0) {
  console.error(`\nsource discipline: ${discipline} violation(s)`);
  process.exit(1);
}
console.log("source discipline: ok (fetch confined to http.ts; tools mutate only via safety.ts)");
