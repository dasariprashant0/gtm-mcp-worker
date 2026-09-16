/**
 * Self-check for the sign-in access probe in src/gtm/http.ts.
 *
 * The two branches worth having are also the two that are painful to exercise
 * live: you would need a colleague with no Tag Manager access, or to switch the
 * Tag Manager API off in production. So they are covered here instead, against
 * the real shapes Google returns.
 *
 * Run with: node scripts/check-probe.ts
 */

import { classifyAccessResponse } from "../src/gtm/http.ts";

let failures = 0;

function is(label: string, actual: unknown, expected: string): void {
  const kind = (actual as { kind?: string })?.kind;
  if (kind !== expected) {
    failures++;
    console.error(`FAIL  ${label}\n      expected kind "${expected}", got "${kind}"`);
  }
}

// --- Has access -------------------------------------------------------------

is(
  "one account -> ok",
  classifyAccessResponse(
    200,
    JSON.stringify({ account: [{ accountId: "6012345678", name: "YourCompany" }] }),
  ),
  "ok",
);

// --- No access. GTM omits the key entirely rather than returning []. --------

is("empty object -> no_accounts", classifyAccessResponse(200, "{}"), "no_accounts");
is("empty body -> no_accounts", classifyAccessResponse(200, ""), "no_accounts");
is(
  "explicit empty array -> no_accounts",
  classifyAccessResponse(200, JSON.stringify({ account: [] })),
  "no_accounts",
);
is(
  "only a pagination token, no accounts -> no_accounts",
  classifyAccessResponse(200, JSON.stringify({ nextPageToken: "" })),
  "no_accounts",
);

// --- API not enabled, in the several ways Google says it --------------------

is(
  "accessNotConfigured -> api_disabled",
  classifyAccessResponse(
    403,
    JSON.stringify({
      error: {
        code: 403,
        message:
          "Tag Manager API has not been used in project 123456 before or it is disabled. " +
          "Enable it by visiting https://console.developers.google.com/apis/api/tagmanager.googleapis.com/overview?project=123456",
        status: "PERMISSION_DENIED",
        details: [{ reason: "SERVICE_DISABLED" }],
      },
    }),
  ),
  "api_disabled",
);

is(
  "bare accessNotConfigured reason -> api_disabled",
  classifyAccessResponse(403, JSON.stringify({ error: { errors: [{ reason: "accessNotConfigured" }] } })),
  "api_disabled",
);

// --- Everything else must fall through without claiming to know -------------
// These MUST NOT be misreported as "no access" or "API off": showing a user a
// confident wrong explanation is worse than showing none, so they fall through
// to the ordinary redirect.

is(
  "401 -> unknown",
  classifyAccessResponse(401, JSON.stringify({ error: { message: "Invalid Credentials" } })),
  "unknown",
);
is(
  "403 for an unrelated reason -> unknown, NOT api_disabled",
  classifyAccessResponse(403, JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } })),
  "unknown",
);
is("429 quota -> unknown", classifyAccessResponse(429, '{"error":{"message":"Quota exceeded"}}'), "unknown");
is("500 -> unknown", classifyAccessResponse(500, "Internal error"), "unknown");
is("200 with garbage body -> unknown", classifyAccessResponse(200, "<html>nope"), "unknown");

if (failures > 0) {
  console.error(`\nprobe check: ${failures} FAILED`);
  process.exit(1);
}
console.log("probe check: all passed");
