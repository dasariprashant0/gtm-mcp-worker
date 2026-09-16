/**
 * Google OAuth handler — the "sign in with Google" half of per-user auth.
 *
 * Ported from the GA4 MCP worker with two changes: the scopes, and a stricter
 * post-consent check (this server needs two Tag Manager scopes, and a user who
 * unticks either one would otherwise fail later with a confusing 403).
 *
 * THE FLOW (this Worker is both an OAuth server and an OAuth client)
 * -----------------------------------------------------------------
 *   Claude ──/authorize──► this Worker ──redirect──► Google consent screen
 *                                                          │
 *   Claude ◄──redirect──── this Worker ◄──/callback────────┘
 *          exchanges for                exchanges code for Google tokens,
 *          an MCP token                 stores them in the encrypted grant
 *
 * Claude never sees the Google tokens. It gets an MCP token issued by this
 * Worker, bound to the stored grant. Every tool call then acts as the person
 * who signed in, with exactly their Tag Manager permissions — which is why
 * there is no service account here and nothing to add as a GTM user.
 *
 * WHY GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET ARE STILL REQUIRED
 * --------------------------------------------------------------
 * Google requires every application that requests user data to be registered,
 * and those two values ARE the registration. This Worker deliberately reuses
 * the GA4 MCP worker's OAuth client: same Cloud project, same consent screen,
 * one more redirect URI. Rotating the secret therefore affects both servers.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { probeTagManagerAccess } from "./gtm/http.ts";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Scopes requested from each user.
 *
 * READ THIS BEFORE ADDING ANYTHING. The absence of the other Tag Manager
 * scopes is load-bearing — it is Layer 1 of the safety model described in
 * src/gtm/allowlist.ts. Adding `tagmanager.publish` or
 * `tagmanager.edit.containerversions` here would make this server capable of
 * publishing to production, which is the one thing it is designed never to do.
 * Adding `tagmanager.delete.containers` would let it delete a container or
 * destroy a colleague's unpublished workspace.
 *
 * `openid` and `email` are identity-only: they grant access to no user data.
 * They exist so the Worker learns a stable user identifier to key the grant
 * on, and an email to put in the audit log. Without them every grant would be
 * anonymous and could not be attributed or revoked per person.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/tagmanager.readonly",
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
  "openid",
  "email",
] as const;

/** Both must come back granted, or tools would fail later with a bare 403. */
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/tagmanager.readonly",
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
] as const;

/**
 * Data stored in the grant's ENCRYPTED props, and handed to tool handlers as
 * `this.props`. The library encrypts this with AES-GCM, so the user's Google
 * refresh token is not readable from KV without the corresponding token.
 */
export interface GoogleAuthProps extends Record<string, unknown> {
  /** Google's stable opaque user ID. Also the grant's userId. */
  sub: string;
  /** For the audit log and for "who am I connected as" answers. Encrypted at rest. */
  email: string;
  /** THIS user's Google refresh token. Never leaves the Worker. */
  googleRefreshToken: string;
}

export interface OAuthEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Injected by OAuthProvider. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Optional: restrict sign-in to one Google Workspace domain, e.g. "example.com". */
  ALLOWED_EMAIL_DOMAIN?: string;
}

// ===========================================================================
// Small helpers
// ===========================================================================

function b64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Read the claims out of a Google id_token.
 *
 * We deliberately do NOT verify the signature. That is safe here, and only
 * here, because this token did not arrive from a browser or a third party — we
 * received it directly from Google's token endpoint over TLS, in the response
 * to a request we made using our own client secret. Verifying a signature on a
 * token fetched over an authenticated channel from its own issuer adds nothing.
 * If this token were ever accepted from any other source, it MUST be verified.
 */
function readIdTokenClaims(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token from Google.");
  return JSON.parse(b64urlDecode(parts[1]!)) as Record<string, unknown>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>` +
      `<style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#111}` +
      `h1{font-size:1.3rem;margin:0 0 .75rem}code{background:#f3f3f3;padding:.1em .35em;border-radius:4px;font-size:.9em}` +
      `.muted{color:#666;font-size:.9em}ul{padding-left:1.2rem}li{margin:.3rem 0}` +
      `.btn{display:inline-block;margin-top:1.25rem;padding:.6em 1.1em;background:#1a73e8;color:#fff;` +
      `text-decoration:none;border-radius:6px;font-size:.95em}.btn:hover{background:#1765cc}` +
      `@media(prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222}.muted{color:#999}}</style>` +
      body,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function logJson(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

// ===========================================================================
// /authorize — start of the flow
// ===========================================================================

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logJson({ event: "oauth_authorize_bad_request", detail: message });
    return htmlPage(
      "Invalid request",
      `<h1>Invalid authorization request</h1><p>${escapeHtml(message)}</p>` +
        `<p class="muted">Start the connection from your MCP client rather than opening this URL directly.</p>`,
      400,
    );
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  if (!client) {
    logJson({ event: "oauth_unknown_client", client_id: authReq.clientId });
    return htmlPage(
      "Unknown client",
      `<h1>Unknown client</h1><p class="muted">This MCP client is not registered with this server.</p>`,
      400,
    );
  }

  // We do not show our own consent screen. Google is about to show a real one
  // naming the exact scopes, and a second homemade dialog adds friction without
  // adding information. The MCP request is carried through Google's `state`.
  const state = b64urlEncode(JSON.stringify(authReq));

  const redirectUri = new URL("/callback", request.url).toString();
  const target = new URL(GOOGLE_AUTH_URL);
  target.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  // offline + consent is what makes Google issue a refresh token every time,
  // rather than only on a user's very first authorization.
  target.searchParams.set("access_type", "offline");
  target.searchParams.set("prompt", "consent");
  target.searchParams.set("include_granted_scopes", "false");
  target.searchParams.set("state", state);
  if (env.ALLOWED_EMAIL_DOMAIN) {
    // A UI hint only — Google does not enforce it. The real check is in /callback.
    target.searchParams.set("hd", env.ALLOWED_EMAIL_DOMAIN);
  }

  logJson({ event: "oauth_authorize_redirect", client_id: authReq.clientId });
  return Response.redirect(target.toString(), 302);
}

// ===========================================================================
// /callback — Google sends the user back here
// ===========================================================================

async function handleCallback(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);

  const googleError = url.searchParams.get("error");
  if (googleError) {
    logJson({ event: "oauth_google_error", detail: googleError });
    return htmlPage(
      "Sign-in cancelled",
      `<h1>Sign-in did not complete</h1><p>Google returned <code>${escapeHtml(googleError)}</code>.</p>` +
        `<p class="muted">If you clicked Cancel, just start the connection again.</p>`,
      400,
    );
  }

  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) {
    return htmlPage("Invalid callback", `<h1>Invalid callback</h1><p class="muted">Missing code or state.</p>`, 400);
  }

  let authReq: AuthRequest;
  try {
    authReq = JSON.parse(b64urlDecode(stateRaw)) as AuthRequest;
  } catch {
    return htmlPage("Invalid callback", `<h1>Invalid callback</h1><p class="muted">State could not be read.</p>`, 400);
  }

  // --- Exchange the one-time code for Google tokens -----------------------
  const redirectUri = new URL("/callback", request.url).toString();
  const form = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const rawBody = await tokenRes.text();

  if (!tokenRes.ok) {
    logJson({ event: "oauth_token_exchange_failed", status: tokenRes.status, detail: rawBody.slice(0, 300) });
    let hint = "";
    if (rawBody.includes("redirect_uri_mismatch")) {
      hint =
        `<p>The redirect URI does not match. Add exactly this to your OAuth client's ` +
        `<b>Authorised redirect URIs</b> in Google Cloud Console:</p><p><code>${escapeHtml(redirectUri)}</code></p>` +
        `<p class="muted">This server shares its OAuth client with the GA4 MCP worker, so the ` +
        `client will already have that worker's callback listed. Add this one alongside it; ` +
        `do not replace it.</p>`;
    }
    return htmlPage(
      "Sign-in failed",
      `<h1>Could not complete sign-in</h1>${hint}<p class="muted">Google returned HTTP ${tokenRes.status}.</p>`,
      502,
    );
  }

  const tokens = JSON.parse(rawBody) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
  };

  // --- Validate what we actually got --------------------------------------
  if (!tokens.refresh_token) {
    // Should not happen: we send prompt=consent on every authorize.
    return htmlPage(
      "Sign-in incomplete",
      `<h1>Google did not return a refresh token</h1>` +
        `<p>Revoke this app at <code>myaccount.google.com/permissions</code> and connect again.</p>`,
      502,
    );
  }
  if (!tokens.id_token) {
    return htmlPage(
      "Sign-in incomplete",
      `<h1>Google did not return an identity token</h1><p class="muted">The 'openid' scope may have been removed.</p>`,
      502,
    );
  }

  // The user can untick scopes on the consent screen. If either Tag Manager
  // scope was declined, every tool would fail later with a confusing 403 —
  // fail now instead, while the person is still in front of the browser.
  if (tokens.scope) {
    const granted = new Set(tokens.scope.split(" "));
    const missing = REQUIRED_SCOPES.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      const readonlyOnly = missing.length === 1 && missing[0]!.endsWith("edit.containers");
      logJson({ event: "oauth_scope_declined", missing: missing.join(",") });
      return htmlPage(
        "Missing permission",
        `<h1>Tag Manager permission was not granted</h1>` +
          (readonlyOnly
            ? `<p>You allowed reading Tag Manager but not managing it, so this server would be ` +
              `able to show you containers and not change anything in them.</p>`
            : `<p>This server needs permission to view and manage your Google Tag Manager containers.</p>`) +
          `<p>Connect again and leave every box ticked.</p>` +
          `<p class="muted">It can still never publish a container or delete one — those need ` +
          `permissions this app does not ask for at all.</p>`,
        403,
      );
    }
  }

  const claims = readIdTokenClaims(tokens.id_token);
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email : "";
  if (!sub) {
    return htmlPage("Sign-in failed", `<h1>Could not identify the account</h1>`, 502);
  }

  // --- Optional domain restriction ----------------------------------------
  if (env.ALLOWED_EMAIL_DOMAIN) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (domain !== env.ALLOWED_EMAIL_DOMAIN.toLowerCase()) {
      logJson({ event: "oauth_domain_rejected", domain: domain ?? "none" });
      return htmlPage(
        "Not permitted",
        `<h1>That account cannot be used</h1>` +
          `<p>Sign in with your <code>@${escapeHtml(env.ALLOWED_EMAIL_DOMAIN)}</code> account.</p>`,
        403,
      );
    }
  }

  // --- Store the grant and hand control back to the MCP client ------------
  const props: GoogleAuthProps = {
    sub,
    email,
    googleRefreshToken: tokens.refresh_token,
  };

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    // Google's opaque subject, NOT the email: userId is stored UNENCRYPTED
    // because the library needs it to enumerate and revoke grants. The email
    // lives in props, which are encrypted.
    userId: sub,
    metadata: { authorizedAt: Date.now() },
    scope: authReq.scope,
    props,
  });

  logJson({ event: "oauth_authorized", sub, email_domain: email.split("@")[1] ?? "unknown" });

  // --- Tell them now if there is nothing for them to see ------------------
  //
  // Signing in and having Tag Manager access are separate things. Someone with
  // the right email domain who was never added to GTM authenticates perfectly
  // and then finds an empty list much later, inside a Claude conversation,
  // where it looks like this server is broken. One request here answers that
  // while they are still in a browser and can act on it.
  //
  // This is deliberately NOT a gate. The grant is already stored, so the page
  // below is an interstitial with a Continue link rather than a refusal:
  //   - the flow still completes, so the connector works;
  //   - an admin can add them to GTM a minute later and everything starts
  //     working with no need to reconnect;
  //   - the read-only reference tools work regardless of GTM access.
  // A probe failure is never allowed to change the outcome — it falls through
  // to the ordinary redirect.
  const probe = tokens.access_token
    ? await probeTagManagerAccess(tokens.access_token)
    : ({ kind: "unknown", detail: "no access_token in token response" } as const);

  logJson({
    event: "oauth_access_probe",
    sub,
    result: probe.kind,
    ...(probe.kind === "ok" ? { accounts: probe.accountCount } : {}),
    ...("detail" in probe ? { detail: probe.detail } : {}),
  });

  const cont =
    `<p><a class="btn" href="${escapeHtml(redirectTo)}">Continue to Claude</a></p>` +
    `<p class="muted">Your sign-in is already saved — continuing just hands control back to the ` +
    `app that sent you here. Do it now rather than later; the handover code is short-lived.</p>`;

  if (probe.kind === "no_accounts") {
    return htmlPage(
      "No Tag Manager access",
      `<h1>Signed in — but this account has no Tag Manager access</h1>` +
        `<p>You are signed in as <code>${escapeHtml(email)}</code>, and that part worked. Google ` +
        `reports that this account can see <b>no Google Tag Manager accounts at all</b>, so every ` +
        `tool will come back empty until someone grants you access.</p>` +
        `<p>Ask a Tag Manager admin to add <code>${escapeHtml(email)}</code> in Tag Manager under ` +
        `<b>Admin &rsaquo; User Management</b>:</p>` +
        `<ul><li><b>View</b> on the container lets you read tags, triggers and variables.</li>` +
        `<li><b>Edit</b> also lets you stage changes in a workspace.</li></ul>` +
        `<p class="muted">Access is granted per container, not just per account — account-level ` +
        `access alone is not enough. Nothing needs redoing here once they add you: this sign-in ` +
        `keeps working and the tools simply start returning data.</p>` +
        cont,
      200,
    );
  }

  if (probe.kind === "api_disabled") {
    return htmlPage(
      "Tag Manager API is not enabled",
      `<h1>Signed in — but the Tag Manager API is switched off</h1>` +
        `<p>Your sign-in worked. Google is refusing the request because the <b>Tag Manager API</b> ` +
        `is not enabled on the Google Cloud project behind this server.</p>` +
        `<p>This is a one-time setup step for whoever deployed it, not something you can fix: ` +
        `Google Cloud Console &rsaquo; APIs &amp; Services &rsaquo; Library &rsaquo; ` +
        `<b>Tag Manager API</b> &rsaquo; Enable. It affects everyone, not just you.</p>` +
        cont,
      200,
    );
  }

  return Response.redirect(redirectTo, 302);
}

// ===========================================================================
// The handler OAuthProvider calls for every non-API request
// ===========================================================================

export function createGoogleAuthHandler(options: {
  /** Serves GET / and GET /health, which must work without a token. */
  publicRoutes: (request: Request, env: never) => Promise<Response> | Response;
}) {
  return {
    async fetch(request: Request, env: OAuthEnv, _ctx: ExecutionContext): Promise<Response> {
      const path = new URL(request.url).pathname;

      if (path === "/authorize") return handleAuthorize(request, env);
      if (path === "/callback") return handleCallback(request, env);

      return options.publicRoutes(request, env as never);
    },
  };
}
