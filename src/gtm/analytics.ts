/**
 * Analytics Engine — queryable time-series for what this server actually does.
 *
 * Workers Logs already carries a JSON line per mutation, but logs are for
 * reading one incident. This is for the questions you ask across weeks: how
 * many writes went through last month, who is using it, which tools error
 * most, how much of the project-wide Tag Manager quota we are burning.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEMA IS POSITIONAL. DO NOT REORDER.
 * ---------------------------------------------------------------------------
 * Analytics Engine has no column names — it stores blob1..blob20 and
 * double1..double20 in the order you pass them. Every query written against
 * this dataset refers to those positions. Inserting a field in the middle
 * silently reinterprets all historical data: your "tool name" column starts
 * returning outcomes for rows older than the change, and nothing errors.
 *
 * So: only ever APPEND new fields at the end, and never repurpose a slot.
 *
 * AND THE SCHEMA IS SHARED. ga4-mcp-worker writes to this same dataset, from
 * src/analytics.ts in that repo. A slot must mean the same thing in both, or
 * the columns a cross-server query reads become nonsense. So append in BOTH
 * repos, or not at all. `blob1` is what tells the two apart; ga4-mcp-worker
 * leaves blob6-blob12 empty and double3 zero, because those are GTM-only.
 *
 *   blob1  server            "gtm-mcp-worker"
 *   blob2  event             "tool" | "mutation"
 *   blob3  tool              tool name, e.g. "gtm_create_tag"
 *   blob4  outcome           "ok" | "error"
 *   blob5  actor             signed-in user's email
 *   blob6  account_id
 *   blob7  container_id
 *   blob8  workspace_id
 *   blob9  entity_type       "tag" | "trigger" | ...
 *   blob10 op                "create" | "update" | "delete" | ...
 *   blob11 gtm_mode          "read_only" | "read_write"
 *   blob12 dry_run           "true" | "false"
 *   blob13 error_kind        coarse classification, "" when outcome is ok
 *
 *   double1 duration_ms
 *   double2 is_error         1 or 0, so AVG() gives an error rate directly
 *   double3 budget_used      mutations used in this session so far
 *
 *   index   the Google `sub` — opaque, stable, one per person
 *
 * ---------------------------------------------------------------------------
 * ON THE INDEX
 * ---------------------------------------------------------------------------
 * Analytics Engine samples by index under load, so the index should be what
 * you most want preserved across sampling. Per-person is right here: it keeps
 * "who did this" accurate even when volume is high. It carries the opaque
 * Google subject rather than the email, so the sampling key is not PII.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY AND RETENTION
 * ---------------------------------------------------------------------------
 * blob5 DOES carry the signed-in user's email address, because "who changed
 * this tag" is the main reason to keep an audit trail at all. It stays inside
 * Cloudflare — the same place Workers Logs already records it — and Analytics
 * Engine retains roughly 90 days. If you would rather it not be there, pass
 * ctx.sub instead of ctx.actor in toolEvent/mutationEvent below; everything
 * else keeps working, and blob5 simply stops being human-readable.
 *
 * Nothing from Tag Manager itself is recorded: no tag names, no parameter
 * values, no container contents. Only which operation ran, on which IDs.
 *
 * ---------------------------------------------------------------------------
 * FAILURE POLICY
 * ---------------------------------------------------------------------------
 * writeDataPoint is fire-and-forget and must never be able to fail a tool
 * call. The binding is optional: absent in local dev, and absent on any
 * deploy made before it was added. Every call here is wrapped.
 */

import type { GtmCtx } from "../env.ts";

const SERVER = "gtm-mcp-worker";

/** Analytics Engine caps a blob set at 5120 bytes total. Keep each one short. */
function blob(value: unknown, max = 128): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * Coarse classification of a failure, so you can chart "are we hitting quota"
 * without full-text searching error messages.
 */
export function classifyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("blocked by the gtm")) return "blocked_by_allowlist";
  if (m.includes("read-only mode")) return "read_only_mode";
  if (m.includes("mutation budget")) return "budget_exhausted";
  if (m.includes("default workspace")) return "default_workspace_refused";
  if (m.includes("refusing to delete") || m.includes("expected_name")) return "delete_unconfirmed";
  if (m.includes("still reference it")) return "references_exist";
  if (m.includes("http 429")) return "quota";
  if (m.includes("http 403")) return "permission";
  if (m.includes("http 401") || m.includes("invalid_grant")) return "auth";
  if (m.includes("http 409") || m.includes("http 412") || m.includes("fingerprint")) return "conflict";
  if (m.includes("http 404")) return "not_found";
  if (m.includes("http 400")) return "bad_request";
  return "other";
}

interface EventFields {
  event: "tool" | "mutation";
  tool: string;
  outcome: "ok" | "error";
  errorKind?: string;
  durationMs: number;
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
  entityType?: string;
  op?: string;
  dryRun?: boolean;
}

function write(ctx: GtmCtx, f: EventFields): void {
  const ds = ctx.env.analytics_engine;
  if (!ds) return; // Not bound: local dev, or a deploy predating the binding.

  try {
    ds.writeDataPoint({
      indexes: [blob(ctx.sub, 96)],
      blobs: [
        SERVER,
        f.event,
        blob(f.tool, 64),
        f.outcome,
        blob(ctx.actor),
        blob(f.accountId, 32),
        blob(f.containerId, 32),
        blob(f.workspaceId, 32),
        blob(f.entityType, 32),
        blob(f.op, 24),
        ctx.env.GTM_MODE === "read_write" ? "read_write" : "read_only",
        f.dryRun === undefined ? "" : String(f.dryRun),
        blob(f.errorKind, 40),
      ],
      doubles: [f.durationMs, f.outcome === "error" ? 1 : 0, ctx.budget.used],
    });
  } catch {
    // Telemetry must never break a tool call. Swallow deliberately.
  }
}

/** One row per tool call, successful or not. */
export function recordToolCall(
  ctx: GtmCtx,
  tool: string,
  durationMs: number,
  error?: string,
): void {
  write(ctx, {
    event: "tool",
    tool,
    outcome: error ? "error" : "ok",
    ...(error ? { errorKind: classifyError(error) } : {}),
    durationMs,
  });
}

/** One extra row per mutation, carrying what was touched. */
export function recordMutation(
  ctx: GtmCtx,
  fields: {
    tool: string;
    op: string;
    entityType?: string;
    accountId: string;
    containerId: string;
    workspaceId?: string;
    dryRun: boolean;
    durationMs: number;
    error?: string;
  },
): void {
  write(ctx, {
    event: "mutation",
    tool: fields.tool,
    outcome: fields.error ? "error" : "ok",
    ...(fields.error ? { errorKind: classifyError(fields.error) } : {}),
    durationMs: fields.durationMs,
    accountId: fields.accountId,
    containerId: fields.containerId,
    workspaceId: fields.workspaceId,
    entityType: fields.entityType,
    op: fields.op,
    dryRun: fields.dryRun,
  });
}
