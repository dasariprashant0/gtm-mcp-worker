/**
 * Worker bindings and the per-session context handed to every tool handler.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  // --- Secrets (wrangler secret put) ---------------------------------------
  /** Google OAuth client ID. Shared with the GA4 MCP worker. */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth client secret. Shared with the GA4 MCP worker. */
  GOOGLE_CLIENT_SECRET: string;

  // --- Plain vars (wrangler.toml [vars]) -----------------------------------
  /** Always "oauth". This server has no shared-credential mode. */
  AUTH_MODE?: string;
  /** e.g. "example.com". Enforced server-side in /callback. */
  ALLOWED_EMAIL_DOMAIN?: string;
  /** "read_only" | "read_write". Anything else, including absent, is read_only. */
  GTM_MODE?: string;
  /** "true" forces every write to behave as dry_run regardless of the caller. */
  GTM_FORCE_DRY_RUN?: string;
  /** "true" lifts the refusal to write to a workspace named "Default Workspace". */
  GTM_ALLOW_DEFAULT_WORKSPACE?: string;
  /** Max mutations per MCP session. Default 50. */
  GTM_MUTATION_BUDGET?: string;

  // --- Bindings ------------------------------------------------------------
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  /** Injected by OAuthProvider; not a wrangler binding. */
  OAUTH_PROVIDER: OAuthHelpers;
}

export type TokenFn = () => Promise<string>;

/**
 * Per-MCP-session context. Built once in GtmMCP.init() and closed over by
 * every tool handler, so a handler can never accidentally act as a different
 * user than the one who signed in.
 */
export interface GtmCtx {
  env: Env;
  /** Mints/returns a Google access token for THIS signed-in user. */
  getToken: TokenFn;
  /** The signed-in user's email, for the audit log. */
  actor: string;
  /** Google's opaque subject for this user. Keys the token cache. */
  sub: string;
  /** Runaway-loop guard, mutable, one per Durable Object session. */
  budget: { used: number; max: number };
}

export function isReadWrite(env: Env): boolean {
  return env.GTM_MODE === "read_write";
}

export function isForcedDryRun(env: Env): boolean {
  return env.GTM_FORCE_DRY_RUN === "true";
}

export function allowsDefaultWorkspace(env: Env): boolean {
  return env.GTM_ALLOW_DEFAULT_WORKSPACE === "true";
}

export function mutationBudget(env: Env): number {
  const n = Number.parseInt(env.GTM_MUTATION_BUDGET ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}
