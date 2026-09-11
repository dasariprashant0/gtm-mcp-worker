/**
 * gtm-mcp-worker — a Google Tag Manager MCP server on Cloudflare Workers.
 *
 * WHAT IT DOES
 * ------------
 * Lets the team inspect and edit GTM containers from Claude. Each teammate
 * signs in with their own Google account, so every call acts with exactly
 * their Tag Manager permissions. There is no service account, no shared
 * credential, and nothing to distribute but the URL.
 *
 * WHAT IT DELIBERATELY CANNOT DO
 * ------------------------------
 * Publish. Create or modify a container version. Preview. Delete a container
 * or a workspace. Manage users. Touch environments.
 *
 * Changes land in a WORKSPACE, where a human reviews them in the Tag Manager
 * UI and publishes if they agree. Three independent layers enforce that:
 *
 *   1. OAuth scope        src/google-oauth.ts — the server never requests
 *                         tagmanager.publish, .edit.containerversions,
 *                         .delete.containers, .manage.users or
 *                         .manage.accounts, so Google itself refuses those
 *                         calls no matter what this code does.
 *   2. Endpoint allowlist src/gtm/allowlist.ts — anchored regexes checked
 *                         before any socket opens, plus a deny list naming the
 *                         forbidden operations explicitly.
 *   3. Write guardrails   src/gtm/safety.ts — read-only mode, dry run, a
 *                         refusal to write to the Default Workspace, delete
 *                         confirmation with a name check and a reference
 *                         check, a per-session mutation budget, and an audit
 *                         log line for every mutation.
 *
 * ROUTES
 *   POST /mcp                           MCP endpoint (OAuth bearer token)
 *   GET  /authorize, /callback          OAuth sign-in
 *   POST /token, /register              OAuth, implemented by the library
 *   GET  /health                        unauthenticated status check
 *   GET  /                              unauthenticated plain-text banner
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.ts";
import { isForcedDryRun, isReadWrite, mutationBudget } from "./env.ts";
import { createGoogleAuthHandler } from "./google-oauth.ts";
import { GtmMCP } from "./mcp.ts";
import { SERVER_NAME, SERVER_VERSION, logJson } from "./gtm/http.ts";
import { TOOL_COUNT } from "./gtm/tools/index.ts";

export { GtmMCP };

// ===========================================================================
// Public routes
// ===========================================================================

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Unauthenticated, so it is cached. Without the cache anyone could make this
 * Worker hammer Google on demand. It reports configuration only — it never
 * touches the Tag Manager API, because there is no server-side credential to
 * test: every token belongs to an individual signed-in user.
 */
function handleHealth(env: Env): Response {
  const problems: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) problems.push("GOOGLE_CLIENT_ID is not set");
  if (!env.GOOGLE_CLIENT_SECRET) problems.push("GOOGLE_CLIENT_SECRET is not set");
  if (!env.OAUTH_KV) problems.push("OAUTH_KV is not bound");
  if (env.AUTH_MODE !== "oauth") problems.push(`AUTH_MODE is ${env.AUTH_MODE ?? "unset"}, expected "oauth"`);

  const healthy = problems.length === 0;
  if (!healthy) logJson({ event: "health_fail", problems });

  return new Response(
    JSON.stringify(
      {
        status: healthy ? "ok" : "misconfigured",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        tools: TOOL_COUNT,
        gtm_mode: isReadWrite(env) ? "read_write" : "read_only",
        forced_dry_run: isForcedDryRun(env),
        mutation_budget: mutationBudget(env),
        allowed_email_domain: env.ALLOWED_EMAIL_DOMAIN ?? null,
        can_publish: false,
        ...(healthy ? {} : { problems }),
      },
      null,
      2,
    ),
    {
      status: healthy ? 200 : 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // Short cache: this is unauthenticated, and the body never changes
        // between deploys anyway.
        "cache-control": "public, max-age=30",
      },
    },
  );
}

function rootText(env: Env): string {
  return (
    `${SERVER_NAME} v${SERVER_VERSION} — Google Tag Manager MCP server.\n\n` +
    `auth:       sign in with Google (per-user OAuth)\n` +
    `mode:       ${isReadWrite(env) ? "read + in-workspace writes" : "READ ONLY"}` +
    `${isForcedDryRun(env) ? " (dry run forced: writes return a preview and change nothing)" : ""}\n` +
    `tools:      ${TOOL_COUNT}\n\n` +
    `POST /mcp     MCP endpoint (OAuth bearer token)\n` +
    `GET  /authorize, /callback, POST /token, /register  — OAuth endpoints\n` +
    `GET  /health  status check for uptime monitoring (no auth required)\n\n` +
    `This server can read Tag Manager and stage changes in a workspace. It cannot publish,\n` +
    `create container versions, delete containers or workspaces, or manage users — a human\n` +
    `does those at tagmanager.google.com. See README.md.\n`
  );
}

async function publicRoutes(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/health") return handleHealth(env);

  if (path === "/" || path === "") {
    return new Response(rootText(env), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return jsonResponse({ error: `Not found: ${path}.` }, 404);
}

// ===========================================================================
// Worker entry point
// ===========================================================================

const mcpHandler = GtmMCP.serve("/mcp");

/**
 * The provider owns /authorize, /token and /register, gates /mcp on a valid
 * bearer token, and passes everything else to the Google handler (which serves
 * /callback plus the public routes).
 *
 * Constructed lazily so a cold start that only serves /health does no extra work.
 */
let oauthWorker: { fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response> } | null =
  null;

function getOAuthWorker(): NonNullable<typeof oauthWorker> {
  if (!oauthWorker) {
    oauthWorker = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: createGoogleAuthHandler({
        publicRoutes: publicRoutes as never,
      }) as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      // Dynamic client registration. MCP clients (including Claude) register
      // themselves on first connect, so there is nothing to configure by hand.
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["tagmanager.readonly", "tagmanager.edit.containers"],
    }) as never;
  }
  return oauthWorker;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getOAuthWorker().fetch(request, env, ctx);
  },
};
