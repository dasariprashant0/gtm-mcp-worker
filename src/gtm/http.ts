/**
 * The ONLY file in this repo that may call fetch() against Google.
 *
 * assertAllowed() and the fetch helpers live adjacent on purpose: the
 * invariant "there is no way to reach the Tag Manager API that skips the
 * allowlist" must be verifiable by reading one screen. If you find yourself
 * writing `fetch(` anywhere under src/gtm/ outside this file, stop.
 */

import type { Env, GtmCtx } from "../env.ts";
import { assertAllowed, type HttpMethod } from "./allowlist.ts";
import { BASE, type ContainerRef } from "./paths.ts";

const SERVER_NAME = "gtm-mcp-worker";
const SERVER_VERSION = "1.0.0";

/** Sent on every outbound call so quota usage is attributable. */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (+cloudflare-workers)`;
export { SERVER_NAME, SERVER_VERSION };

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function logJson(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}... [truncated ${s.length - n} chars]`;
}

// ===========================================================================
// Access token: mint from the user's refresh token, cache in module scope
// ===========================================================================
//
// Module scope on Workers is per-isolate and can be evicted at any time, so
// this is best-effort, never a correctness dependency. Worst case we mint a
// token more often than strictly necessary.

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Keyed on the Google `sub`, so two teammates never share a cache entry. */
const tokenCache = new Map<string, CachedToken>();
/** De-dupes concurrent refreshes so nine parallel tool calls mint one token. */
const inFlightTokens = new Map<string, Promise<string>>();
/** Refresh this many ms BEFORE the stated expiry, to absorb skew + latency. */
const TOKEN_SKEW_MS = 60_000;

const INVALID_GRANT_HELP =
  "Google rejected the refresh token (invalid_grant).\n\n" +
  "MOST LIKELY CAUSE: the OAuth consent screen for this Google Cloud project has user type " +
  '"External" and is still in "Testing" status. Google expires refresh tokens issued by a ' +
  "Testing-status External app after 7 days, without warning. Fix: Google Cloud Console -> " +
  "APIs & Services -> OAuth consent screen -> PUBLISH APP, then sign in again. (Apps with user " +
  'type "Internal" are not affected by this expiry at all, which is why Internal is the ' +
  "recommended setting, and what this server is deployed against.)\n\n" +
  "Other possible causes: the Google account password was changed; the user revoked access at " +
  "myaccount.google.com/permissions; the token was superseded (Google keeps roughly the last " +
  "100 refresh tokens per OAuth client and silently invalidates older ones); or " +
  "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET do not belong to the same OAuth client that issued " +
  "the refresh token.\n\n" +
  "The fix from the user's side is always the same: remove and re-add this connector, and sign " +
  "in with Google again.";

async function mintAccessToken(env: Env, refreshToken: string, cacheKey: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: body.toString(),
  });

  const raw = await res.text();
  if (!res.ok) {
    let errCode = "";
    try {
      errCode = (JSON.parse(raw) as { error?: string }).error ?? "";
    } catch {
      // keep the raw body
    }
    if (errCode === "invalid_grant") throw new Error(INVALID_GRANT_HELP);
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${truncate(raw, 300)}`);
  }

  const json = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("Google's token endpoint returned 200 but no access_token was present.");
  }
  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

async function getAccessTokenFor(
  env: Env,
  refreshToken: string,
  cacheKey: string,
): Promise<string> {
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - TOKEN_SKEW_MS) return cached.token;

  const pending = inFlightTokens.get(cacheKey);
  if (pending) return pending;

  const p = mintAccessToken(env, refreshToken, cacheKey).finally(() => {
    inFlightTokens.delete(cacheKey);
  });
  inFlightTokens.set(cacheKey, p);
  return p;
}

/** Token source bound to one signed-in user's grant. */
export function userTokenSource(env: Env, sub: string, refreshToken: string): () => Promise<string> {
  return () => getAccessTokenFor(env, refreshToken, `user:${sub}`);
}

// ===========================================================================
// Error explanation
// ===========================================================================

export function explainGtmError(status: number, raw: string, url: string, method: string): Error {
  let message = truncate(raw, 800);
  let reason = "";
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) message = parsed.error.message;
    if (parsed.error?.status) reason = parsed.error.status;
  } catch {
    // keep the raw body
  }

  const lower = `${message} ${reason}`.toLowerCase();
  let hint = "";

  if (status === 401) {
    hint =
      "\n\nHINT: the access token was rejected. Either the Google sign-in has expired or been " +
      "revoked (remove and re-add this connector, then sign in again), or the Tag Manager API " +
      "is not enabled on the Google Cloud project behind this OAuth client. GET /health on this " +
      "worker reports token status directly.";
  } else if (status === 403 && (lower.includes("scope") || lower.includes("insufficient"))) {
    hint =
      "\n\nHINT: this operation needs an OAuth scope this server deliberately does not hold. " +
      "That is intentional, not a misconfiguration. This server holds tagmanager.readonly and " +
      "tagmanager.edit.containers only — it cannot publish, create container versions, delete " +
      "containers or workspaces, or manage users. Ask the user to do this in the Tag Manager UI.";
  } else if (status === 403) {
    hint =
      "\n\nHINT: two common causes.\n" +
      "  1. PERMISSION. The signed-in Google account does not have the required access to this " +
      "container. Reading needs at least View; writing needs Edit or higher, granted on the " +
      "CONTAINER (Tag Manager -> Admin -> Container -> User Management), not just on the " +
      "account. Call gtm_list_containers to see exactly what this account can reach.\n" +
      "  2. API NOT ENABLED. The Tag Manager API may not be enabled on the Google Cloud project " +
      "that owns this OAuth client.";
  } else if (status === 400) {
    hint =
      "\n\nHINT: almost always a malformed 'parameters' array or an unknown 'type' string.\n" +
      "  - Values are ALWAYS strings: \"false\" not false, \"5\" not 5.\n" +
      "  - type:\"list\" carries a 'list' key and type:\"map\" carries a 'map' key, never 'value'.\n" +
      "  - Entries directly inside a 'list' have no 'key' of their own.\n" +
      "  - A GA4 event tag references its Google Tag with type:\"tagReference\" and the tag's " +
      "NAME, not a G- measurement ID.\n" +
      "  - Variable references are {{Exact Variable Name}} as returned by gtm_list_entities.\n" +
      "Call gtm_get_type_reference for the valid type strings (it costs no API quota), or call " +
      "gtm_get_entity on a working entity of the same type in this container and copy its " +
      "parameter array. Copying beats guessing.";
  } else if (status === 404) {
    hint =
      "\n\nHINT: one of the IDs in the path does not exist, or exists somewhere else. The IDs " +
      "are nested, and entity IDs restart at 1 in every container — so a tag ID copied from " +
      "another container or another workspace points at something unrelated, or at nothing. " +
      "Re-derive the whole path: gtm_list_containers -> gtm_list_workspaces -> " +
      "gtm_list_entities. If you started from a GTM-XXXXXXX public ID, gtm_lookup_container " +
      "gives you the numeric one.";
  } else if (status === 409 || status === 412) {
    hint =
      "\n\nHINT: fingerprint mismatch — someone changed this entity between the moment this " +
      "server read it and the moment it tried to write. GTM uses the 'fingerprint' field for " +
      "optimistic concurrency.\n\nThis server does NOT retry automatically, on purpose: a blind " +
      "retry would overwrite whatever the other editor just did. Call gtm_get_entity to see the " +
      "current state, confirm with the user that the change still makes sense on top of it, " +
      "then retry. If a human is editing this workspace in the GTM UI right now, stop and " +
      "coordinate with them.";
  } else if (status === 429) {
    hint =
      "\n\nHINT: Tag Manager API quota exhausted. The limits are PROJECT-WIDE, not per-container, " +
      "and far tighter than GA4's — on the order of 10,000 requests per day with a low " +
      "per-second ceiling, shared by everyone using this server. Wait before retrying; do not " +
      "loop. Reduce cost by calling gtm_list_entities with summary=true (the default) instead " +
      "of fetching every entity, and by doing all your reads before you start writing.";
  } else if (status >= 500) {
    hint =
      "\n\nHINT: a Tag Manager server-side error. These are usually transient. If you were " +
      "writing, check with gtm_get_workspace_status whether the change actually landed before " +
      "retrying — a 500 does not always mean nothing happened.";
  }

  return new Error(
    `Tag Manager API error (HTTP ${status}${reason ? ` ${reason}` : ""}) for ${method} ${url}: ` +
      `${message}${hint}`,
  );
}

// ===========================================================================
// Fetch helpers. Every one calls assertAllowed FIRST.
// ===========================================================================

async function call(
  ctx: GtmCtx,
  method: HttpMethod,
  url: string,
  payload?: unknown,
): Promise<unknown> {
  // Layer 2, before any socket is opened, on the exact string we then fetch.
  assertAllowed(url, method);

  const token = await ctx.getToken();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "user-agent": USER_AGENT,
    accept: "application/json",
  };
  if (payload !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  const raw = await res.text();
  if (!res.ok) throw explainGtmError(res.status, raw, url, method);
  return raw ? (JSON.parse(raw) as unknown) : {};
}

export function gtmGet(ctx: GtmCtx, url: string): Promise<unknown> {
  return call(ctx, "GET", url);
}
export function gtmPost(ctx: GtmCtx, url: string, payload?: unknown): Promise<unknown> {
  return call(ctx, "POST", url, payload ?? {});
}
export function gtmPut(ctx: GtmCtx, url: string, payload: unknown): Promise<unknown> {
  return call(ctx, "PUT", url, payload);
}
export function gtmDelete(ctx: GtmCtx, url: string): Promise<unknown> {
  return call(ctx, "DELETE", url);
}

/**
 * Follow nextPageToken with a hard cap, so a pathological account cannot spin
 * here forever and burn the project-wide quota.
 */
export async function gtmGetPaged(
  ctx: GtmCtx,
  baseUrl: string,
  itemsKey: string,
  pageSize = 200,
  maxPages = 10,
): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  for (;;) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = pageToken
      ? `${baseUrl}${sep}pageSize=${pageSize}&pageToken=${encodeURIComponent(pageToken)}`
      : `${baseUrl}${sep}pageSize=${pageSize}`;

    const body = (await gtmGet(ctx, url)) as Record<string, unknown>;
    const chunk = body[itemsKey];
    if (Array.isArray(chunk)) items.push(...chunk);

    pages++;
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    if (!pageToken || pages >= maxPages) {
      return { items, truncated: Boolean(pageToken) };
    }
  }
}

// ===========================================================================
// Resolving a public container ID (GTM-XXXXXXX) to numeric IDs
// ===========================================================================

/** Isolate-lifetime cache. A handful of containers per deployment; unbounded is fine. */
const containerLookupCache = new Map<string, { accountId: string; containerId: string }>();

export interface ResolvedContainer {
  accountId: string;
  containerId: string;
  /** Present only when a lookup actually happened, so the caller can report it. */
  resolvedFrom?: { destinationId: string; via: string };
}

export async function resolveContainerRef(
  ctx: GtmCtx,
  ref: ContainerRef,
  suppliedAccountId?: string,
): Promise<ResolvedContainer> {
  if (ref.kind === "numeric") {
    const accountId = ref.accountId ?? suppliedAccountId;
    if (!accountId) {
      throw new Error(
        `account_id is required alongside a numeric container_id. Call gtm_list_accounts, or ` +
          `pass the public container ID (GTM-XXXXXXX) instead and this server will resolve both.`,
      );
    }
    if (ref.accountId && suppliedAccountId && ref.accountId !== suppliedAccountId) {
      throw new Error(
        `Conflicting account_id: the container path you passed says ${ref.accountId}, but ` +
          `account_id says ${suppliedAccountId}. Pass them consistently, or pass only the full ` +
          `resource name.`,
      );
    }
    return { accountId, containerId: ref.containerId };
  }

  const cached = containerLookupCache.get(ref.destinationId);
  const hit =
    cached ??
    (await (async () => {
      const url = `${BASE}/accounts/containers:lookup?destination_id=${encodeURIComponent(
        ref.destinationId,
      )}`;
      const body = (await gtmGet(ctx, url)) as { accountId?: string; containerId?: string };
      if (!body.accountId || !body.containerId) {
        throw new Error(
          `containers:lookup found no container for ${ref.destinationId}. Check the ID, and ` +
            `check that the signed-in Google account has access to the container that holds it.`,
        );
      }
      const found = { accountId: body.accountId, containerId: body.containerId };
      containerLookupCache.set(ref.destinationId, found);
      return found;
    })());

  if (suppliedAccountId && suppliedAccountId !== hit.accountId) {
    throw new Error(
      `${ref.destinationId} lives in account ${hit.accountId}, but account_id says ` +
        `${suppliedAccountId}. Drop account_id and let the lookup supply it, or correct it.`,
    );
  }

  return {
    ...hit,
    resolvedFrom: { destinationId: ref.destinationId, via: "accounts/containers:lookup" },
  };
}
