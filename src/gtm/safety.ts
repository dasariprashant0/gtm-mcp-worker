/**
 * Layer 3: the write guardrails.
 *
 * Layer 1 (OAuth scope) and Layer 2 (the endpoint allowlist, src/gtm/allowlist.ts)
 * make it impossible to publish or to destroy anything outside a workspace.
 * Neither of them stops a confused agent from deleting the right container's
 * wrong tag, or from looping and filling a workspace with junk. That is what
 * this file is for.
 *
 * EVERY mutation goes through mutate(). Write tools must not import gtmPost /
 * gtmPut / gtmDelete directly — `npm run check` fails the build if they do.
 */

import {
  allowsDefaultWorkspace,
  isForcedDryRun,
  isReadWrite,
  type GtmCtx,
} from "../env.ts";
import { recordMutation, recordToolCall } from "./analytics.ts";
import { gtmDelete, gtmGet, gtmPost, gtmPut, logJson, truncate } from "./http.ts";
import { workspacePath, type GtmIds } from "./paths.ts";

// ===========================================================================
// Tool results
// ===========================================================================

export interface ToolResult {
  // The MCP SDK's CallToolResult carries an open index signature; without it
  // here, every `server.tool(...)` registration fails to typecheck.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * Compact, not pretty-printed. Measured on the GA4 worker at roughly 57%
 * smaller on a typical response, and the model parses both identically.
 */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * Wraps every handler. Handlers never throw out to the transport: a failure
 * comes back as text with isError, so the model can read the hint and
 * self-correct instead of the connection dropping.
 *
 * Bound to a ctx rather than free-standing, so every tool call is timed and
 * recorded to Analytics Engine without each of the 27 registrations having to
 * remember to do it. Call sites are unchanged — registerReadTools and
 * registerWriteTools each open with `const guard = makeGuard(ctx)`.
 */
export function makeGuard(ctx: GtmCtx) {
  return function guard(name: string, fn: () => Promise<unknown>): Promise<ToolResult> {
    const started = Date.now();
    return fn()
      .then((data) => {
        recordToolCall(ctx, name, Date.now() - started);
        return ok(data);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logJson({ event: "tool_error", tool: name, message: truncate(message, 600) });
        recordToolCall(ctx, name, Date.now() - started, message);
        return {
          content: [{ type: "text" as const, text: `Tool '${name}' failed.\n\n${message}` }],
          isError: true,
        };
      });
  };
}

// ===========================================================================
// Workspace policy
// ===========================================================================

/** Isolate-lifetime cache of workspace path -> name. */
const workspaceNameCache = new Map<string, string>();

export async function workspaceName(ctx: GtmCtx, ids: GtmIds): Promise<string> {
  const path = workspacePath(ids);
  const cached = workspaceNameCache.get(path);
  if (cached !== undefined) return cached;

  const ws = (await gtmGet(ctx, path)) as { name?: string };
  const name = ws.name ?? "";
  workspaceNameCache.set(path, name);
  return name;
}

const DEFAULT_WORKSPACE_NAMES = new Set(["default workspace"]);

/**
 * Refuse to write to the Default Workspace.
 *
 * That is where humans leave half-finished work. Mixing agent edits into it
 * means their next publish ships our changes unreviewed — which is exactly the
 * outcome "this server never publishes" is supposed to prevent.
 */
export async function assertWorkspaceWritable(ctx: GtmCtx, ids: GtmIds): Promise<string> {
  const name = await workspaceName(ctx, ids);
  if (allowsDefaultWorkspace(ctx.env)) return name;

  if (DEFAULT_WORKSPACE_NAMES.has(name.trim().toLowerCase())) {
    throw new Error(
      `Refusing to write to the "Default Workspace" (workspace ${ids.workspaceId}).\n\n` +
        `Agent edits belong in their own workspace so a human can review them separately ` +
        `before publishing. Call gtm_create_workspace with a descriptive name — something ` +
        `like "claude-lead-tracking" — and retry with that workspace_id.\n\n` +
        `(A deployer can lift this with GTM_ALLOW_DEFAULT_WORKSPACE="true", but the default ` +
        `exists for a good reason.)`,
    );
  }
  return name;
}

// ===========================================================================
// The mutation wrapper
// ===========================================================================

export type MutationOp =
  | "create"
  | "update"
  | "delete"
  | "revert"
  | "sync"
  | "enable"
  | "disable"
  | "move";

export interface MutationPlan {
  op: MutationOp;
  method: "POST" | "PUT" | "DELETE";
  url: string;
  /** Omitted for DELETE and for query-string-only writes. */
  body?: unknown;
  ids: GtmIds;
  entityType?: string;
  entityId?: string;
  /** Current name of the affected entity, for the audit log and the dry-run preview. */
  entityName?: string;
  /** Free-form extras surfaced in the dry-run preview, e.g. merge diffs. */
  preview?: Record<string, unknown>;
}

export interface MutateOptions {
  /** What the caller asked for. GTM_FORCE_DRY_RUN can override this to true. */
  dryRun?: boolean;
}

/**
 * The single door every write goes through. In order:
 *   1. GTM_MODE must be read_write (absent or misspelt => read_only, fails closed)
 *   2. the per-session mutation budget must not be exhausted
 *   3. the target workspace must not be the Default Workspace
 *   4. dry run short-circuits here, having done all the work but none of the damage
 *   5. the attempt is logged, executed, and the result logged
 */
export async function mutate(
  ctx: GtmCtx,
  plan: MutationPlan,
  opts: MutateOptions = {},
): Promise<unknown> {
  // --- 1. Mode ------------------------------------------------------------
  if (!isReadWrite(ctx.env)) {
    throw new Error(
      `This GTM MCP server is deployed in READ-ONLY mode (GTM_MODE is not "read_write"). ` +
        `Writes are disabled; reads still work.\n\n` +
        `This is a deployment setting, not something that can be overridden per call. If ` +
        `writes are supposed to be on, the deployer needs to set GTM_MODE = "read_write" in ` +
        `wrangler.toml and redeploy.`,
    );
  }

  // --- 2. Budget ----------------------------------------------------------
  if (ctx.budget.used >= ctx.budget.max) {
    throw new Error(
      `Mutation budget exhausted for this session (${ctx.budget.max} writes).\n\n` +
        `This is a runaway-loop guard, and it is also the main thing protecting the ` +
        `project-wide Tag Manager API quota. If the work is genuinely this large, start a new ` +
        `session, or ask the deployer to raise GTM_MUTATION_BUDGET.`,
    );
  }

  // --- 3. Workspace policy ------------------------------------------------
  const wsName = plan.ids.workspaceId ? await assertWorkspaceWritable(ctx, plan.ids) : undefined;

  // --- 4. Dry run ---------------------------------------------------------
  const forced = isForcedDryRun(ctx.env);
  const dryRun = forced || opts.dryRun === true;

  const audit = {
    actor: ctx.actor,
    account_id: plan.ids.accountId,
    container_id: plan.ids.containerId,
    workspace_id: plan.ids.workspaceId,
    workspace_name: wsName,
    op: plan.op,
    entity_type: plan.entityType,
    entity_id: plan.entityId,
    entity_name: plan.entityName,
    method: plan.method,
    dry_run: dryRun,
  };

  if (dryRun) {
    logJson({ event: "mutation_dry_run", ...audit });
    recordMutation(ctx, {
      tool: plan.op,
      op: plan.op,
      entityType: plan.entityType,
      accountId: plan.ids.accountId,
      containerId: plan.ids.containerId,
      workspaceId: plan.ids.workspaceId,
      dryRun: true,
      durationMs: 0,
    });
    return {
      dry_run: true,
      forced_by_server: forced,
      note: forced
        ? "This server is deployed with GTM_FORCE_DRY_RUN=true, so every write returns a " +
          "preview and nothing is changed in Tag Manager. Nothing you pass can override that."
        : "Nothing was changed in Tag Manager. Re-run without dry_run to apply this.",
      would_send: { method: plan.method, url: plan.url, body: plan.body },
      target: audit,
      ...(plan.preview ?? {}),
    };
  }

  // --- 5. Execute ---------------------------------------------------------
  ctx.budget.used++;
  logJson({ event: "mutation_attempt", ...audit, budget_used: ctx.budget.used });

  const started = Date.now();
  try {
    const result =
      plan.method === "POST"
        ? await gtmPost(ctx, plan.url, plan.body)
        : plan.method === "PUT"
          ? await gtmPut(ctx, plan.url, plan.body)
          : await gtmDelete(ctx, plan.url);

    logJson({
      event: "mutation_result",
      ...audit,
      outcome: "ok",
      duration_ms: Date.now() - started,
      budget_remaining: ctx.budget.max - ctx.budget.used,
    });
    recordMutation(ctx, {
      tool: plan.op,
      op: plan.op,
      entityType: plan.entityType,
      accountId: plan.ids.accountId,
      containerId: plan.ids.containerId,
      workspaceId: plan.ids.workspaceId,
      dryRun: false,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logJson({
      event: "mutation_result",
      ...audit,
      outcome: "error",
      duration_ms: Date.now() - started,
      message: truncate(message, 300),
    });
    recordMutation(ctx, {
      tool: plan.op,
      op: plan.op,
      entityType: plan.entityType,
      accountId: plan.ids.accountId,
      containerId: plan.ids.containerId,
      workspaceId: plan.ids.workspaceId,
      dryRun: false,
      durationMs: Date.now() - started,
      error: message,
    });
    throw err;
  }
}

// ===========================================================================
// Delete confirmation
// ===========================================================================

export interface DeleteGuardArgs {
  confirm?: unknown;
  expected_name?: unknown;
  force?: unknown;
}

/**
 * Requires confirm=true AND an expected_name that matches what is actually
 * there. The name check is the one that earns its keep: the most likely agent
 * failure by far is a stale or guessed numeric ID pointing at a different
 * entity than the one under discussion, and a numeric ID alone gives the model
 * nothing to notice that with.
 */
export function assertDeleteConfirmed(
  args: DeleteGuardArgs,
  actual: { name?: string; id: string; type: string },
): void {
  const label = `${actual.type} ${actual.id}${actual.name ? ` "${actual.name}"` : ""}`;

  if (args.confirm !== true) {
    throw new Error(
      `Refusing to delete ${label} without confirmation.\n\n` +
        `Show the user exactly what is about to be deleted, then re-run with confirm=true and ` +
        `expected_name=${JSON.stringify(actual.name ?? "")}.\n\n` +
        `Note this removes it from the WORKSPACE only — the live site is unaffected until a ` +
        `human creates a version and publishes.`,
    );
  }

  const expected = typeof args.expected_name === "string" ? args.expected_name.trim() : "";
  if (!expected) {
    throw new Error(
      `Refusing to delete ${label}: expected_name is required alongside confirm=true.\n\n` +
        `Pass expected_name=${JSON.stringify(actual.name ?? "")}. This exists to catch a stale ` +
        `or guessed entity ID pointing at something other than what you and the user discussed.`,
    );
  }

  if (expected.toLowerCase() !== (actual.name ?? "").trim().toLowerCase()) {
    throw new Error(
      `Refusing to delete: expected_name does not match.\n\n` +
        `  you said:  ${JSON.stringify(expected)}\n` +
        `  actually:  ${JSON.stringify(actual.name ?? "")}  (${actual.type} ${actual.id})\n\n` +
        `Entity IDs are per-workspace and restart at 1 in every container, so an ID from ` +
        `another container or workspace points at something unrelated. Call gtm_list_entities ` +
        `in THIS workspace to find the right ID, and confirm with the user before retrying.`,
    );
  }
}

/** Refuses when other entities still reference the target, unless force=true. */
export function assertNoReferences(
  args: DeleteGuardArgs,
  refs: { type: string; id: string; name: string; why: string }[],
  target: { name?: string; id: string; type: string },
): void {
  if (refs.length === 0 || args.force === true) return;
  const list = refs
    .slice(0, 15)
    .map((r) => `  - ${r.type} ${r.id} "${r.name}" (${r.why})`)
    .join("\n");
  throw new Error(
    `Refusing to delete ${target.type} ${target.id} "${target.name ?? ""}": ` +
      `${refs.length} other ${refs.length === 1 ? "entity" : "entities"} still reference it.\n\n` +
      `${list}${refs.length > 15 ? `\n  ... and ${refs.length - 15} more` : ""}\n\n` +
      `Deleting it will break them. Update or remove those first, or pass force=true if you ` +
      `and the user have decided the breakage is acceptable.`,
  );
}
