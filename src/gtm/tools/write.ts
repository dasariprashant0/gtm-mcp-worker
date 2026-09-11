/**
 * Write tools. Everything here goes through mutate() in ../safety.ts, which
 * enforces GTM_MODE, the mutation budget, the Default-Workspace refusal, and
 * dry-run. Nothing in this file may import gtmPost / gtmPut / gtmDelete
 * directly — `npm run check` fails the build if it does.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GtmCtx } from "../../env.ts";
import { gtmGet } from "../http.ts";
import {
  DELETE_HINT,
  DRY_RUN_HINT,
  IDS_HINT,
  PARAMETER_ARRAY_HINT,
  TAG_EXAMPLE_HINT,
  TRIGGER_CONDITION_HINT,
  UPDATE_MERGE_HINT,
  VARIABLE_EXAMPLE_HINT,
  WORKSPACE_HINT,
} from "../hints.ts";
import {
  collectionPath,
  containerPath,
  entityPath,
  withQuery,
  withRepeatedQuery,
  workspacePath,
  type GtmIds,
} from "../paths.ts";
import { normArray, toGtmParameters, toIdList } from "../params.ts";
import {
  assertDeleteConfirmed,
  assertNoReferences,
  guard,
  mutate,
  type MutationOp,
} from "../safety.ts";
import { WRITE_ENTITY_TYPES, decorate, entityMeta, plainIds, resolveIds } from "./common.ts";
import { findReferences } from "./read.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const accountArg = z
  .union([z.string(), z.number()])
  .optional()
  .describe("GTM account ID. Optional only when container_id is a GTM-XXXXXXX public ID.");
const containerArg = z
  .union([z.string(), z.number()])
  .describe('Container ID: numeric or public ("GTM-XXXXXXX").');
const workspaceArg = z
  .union([z.string(), z.number()])
  .describe("Workspace ID. Required. Must not be the Default Workspace.");
const dryRunArg = z
  .boolean()
  .optional()
  .describe("Preview the exact request without changing anything. See the tool description.");
const notesArg = z.string().optional().describe("Free-text note shown in the GTM UI.");
const folderArg = z
  .union([z.string(), z.number()])
  .optional()
  .describe("parentFolderId — put the entity in this folder.");

/** Fields GTM owns. Never send them back on an update. */
const SERVER_MANAGED = new Set([
  "path",
  "fingerprint",
  "tagManagerUrl",
  "accountId",
  "containerId",
  "workspaceId",
  "_parameters",
]);

function stripServerManaged(entity: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (!SERVER_MANAGED.has(k)) out[k] = v;
  }
  return out;
}

function diffKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SERVER_MANAGED.has(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      changed[k] = { from: before[k], to: after[k] };
    }
  }
  return changed;
}

/** Assemble the parts of an entity body that every writable kind shares. */
function commonBody(args: any, label: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.name !== undefined) body.name = String(args.name);
  if (args.notes !== undefined) body.notes = String(args.notes);
  if (args.parent_folder_id !== undefined && args.parent_folder_id !== null) {
    body.parentFolderId = String(args.parent_folder_id);
  }
  const params = toGtmParameters(args.parameters, `${label}.parameters`);
  if (params) body.parameter = params;
  return body;
}

// ===========================================================================
// Shared create / update
// ===========================================================================

async function createEntity(
  ctx: GtmCtx,
  args: any,
  kind: "tag" | "trigger" | "variable" | "folder",
  body: Record<string, unknown>,
): Promise<unknown> {
  const ids = await resolveIds(ctx, args, { workspace: true });
  const meta = entityMeta(kind, { forWrite: true });
  if (!body.name) {
    throw new Error(`name is required to create a ${kind}.`);
  }
  if (kind !== "folder" && !body.type) {
    throw new Error(
      `type is required to create a ${kind}. Call gtm_get_type_reference for the valid type ` +
        `strings — they are short and opaque (a Constant variable is "c", a GA4 Event tag is ` +
        `"gaawe") and cannot be guessed.`,
    );
  }

  const plain = plainIds(ids);
  const result = await mutate(
    ctx,
    {
      op: "create",
      method: "POST",
      url: collectionPath(plain, meta.collection),
      body,
      ids: plain,
      entityType: kind,
      entityName: String(body.name),
    },
    { dryRun: args.dry_run === true },
  );
  return decorate(result);
}

async function updateEntity(
  ctx: GtmCtx,
  args: any,
  kind: "tag" | "trigger" | "variable" | "folder",
  patch: Record<string, unknown>,
  entityId: unknown,
): Promise<unknown> {
  const ids = await resolveIds(ctx, args, { workspace: true });
  const meta = entityMeta(kind, { forWrite: true });
  const plain: GtmIds = plainIds(ids);
  const url = entityPath(plain, meta.collection, entityId);

  // Read-modify-write. GTM's PUT is a full replace: sending only the fields
  // you want to change would silently strip everything else.
  const current = (await gtmGet(ctx, url)) as Record<string, unknown>;
  const before = stripServerManaged(current);

  const merged =
    args.replace === true ? { ...patch } : { ...before, ...patch };

  const changed = diffKeys(before, merged);
  if (Object.keys(changed).length === 0) {
    return {
      unchanged: true,
      note:
        `Nothing to do — the ${kind} already matches what you asked for. No request was sent ` +
        `to Tag Manager.`,
      entity: decorate(current),
    };
  }

  const fingerprint =
    typeof args.fingerprint === "string" && args.fingerprint.trim()
      ? args.fingerprint.trim()
      : typeof current.fingerprint === "string"
        ? current.fingerprint
        : undefined;

  const result = await mutate(
    ctx,
    {
      op: "update",
      method: "PUT",
      url: withQuery(url, { fingerprint }),
      body: merged,
      ids: plain,
      entityType: kind,
      entityId: String(entityId),
      entityName: String(merged.name ?? current.name ?? ""),
      preview: { changed, merge_mode: args.replace === true ? "replace" : "merge" },
    },
    { dryRun: args.dry_run === true },
  );

  const out = decorate(result);
  return out && typeof out === "object" ? { ...(out as object), changed } : out;
}

// ===========================================================================
// Registration
// ===========================================================================

export function registerWriteTools(server: McpServer, ctx: GtmCtx): void {
  // -----------------------------------------------------------------------
  // gtm_create_workspace
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_create_workspace",
    `Create a workspace to hold a set of changes. Do this FIRST, before any edit.
${WORKSPACE_HINT}

Name it after the change, not after yourself — "lead-form-tracking" reads better in the GTM
change log than "claude". Free GTM containers cap at 3 workspaces; if creation fails with a
quota error, an existing workspace needs publishing or discarding by a human first.
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      name: z.string().describe('e.g. "lead-form-tracking".'),
      description: z.string().optional().describe("What this set of changes is for."),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_create_workspace", async () => {
        const ids = await resolveIds(ctx, args);
        const plain = plainIds(ids);
        return mutate(
          ctx,
          {
            op: "create",
            method: "POST",
            url: `${containerPath(plain)}/workspaces`,
            body: {
              name: String(args.name),
              ...(args.description ? { description: String(args.description) } : {}),
            },
            ids: plain,
            entityType: "workspace",
            entityName: String(args.name),
          },
          { dryRun: args.dry_run === true },
        );
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_sync_workspace
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_sync_workspace",
    `Pull changes from the live container version into a workspace that has fallen behind, and
report any merge conflicts.

Needed when gtm_get_workspace_status shows conflicts — someone published while this workspace
was open. Conflicts it cannot resolve automatically are returned for a human to settle in the
GTM UI; this server cannot resolve them.
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      confirm: z.boolean().optional().describe("Must be true. Syncing rewrites workspace contents."),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_sync_workspace", async () => {
        if (args.confirm !== true && args.dry_run !== true) {
          throw new Error(
            "Refusing to sync without confirm=true. Syncing merges the live version into this " +
              "workspace and can change entities someone else is working on. Run " +
              "gtm_get_workspace_status first and show the user what is pending.",
          );
        }
        const ids = await resolveIds(ctx, args, { workspace: true });
        const plain = plainIds(ids);
        return mutate(
          ctx,
          {
            op: "sync",
            method: "POST",
            url: `${workspacePath(plain)}:sync`,
            ids: plain,
            entityType: "workspace",
            entityId: plain.workspaceId,
          },
          { dryRun: args.dry_run === true },
        );
      }),
  );

  // -----------------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_create_tag",
    `Create a tag in a workspace. The tag is staged only — it does not affect the live site until
a human creates a version and publishes.
${IDS_HINT}
${PARAMETER_ARRAY_HINT}
${TAG_EXAMPLE_HINT}
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      name: z.string().describe('Display name, e.g. "GA4 Event - generate_lead".'),
      type: z.string().describe('Tag type code, e.g. "gaawe", "googtag", "html". See gtm_get_type_reference.'),
      parameters: z
        .any()
        .optional()
        .describe("Parameter array, or a flat {key: value} object. See the tool description."),
      firing_trigger_id: z
        .any()
        .optional()
        .describe("List of trigger IDs that fire this tag, e.g. ['12']. From gtm_list_entities."),
      blocking_trigger_id: z.any().optional().describe("List of trigger IDs that block this tag."),
      tag_firing_option: z
        .string()
        .optional()
        .describe("ONCE_PER_EVENT | ONCE_PER_LOAD | UNLIMITED."),
      paused: z.boolean().optional().describe("Create it paused, so it is staged but inert."),
      parent_folder_id: folderArg,
      notes: notesArg,
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_create_tag", () => {
        const body = commonBody(args, "gtm_create_tag");
        body.type = String(args.type);
        const firing = toIdList(args.firing_trigger_id, "firing_trigger_id");
        if (firing) body.firingTriggerId = firing;
        const blocking = toIdList(args.blocking_trigger_id, "blocking_trigger_id");
        if (blocking) body.blockingTriggerId = blocking;
        if (args.tag_firing_option) body.tagFiringOption = String(args.tag_firing_option);
        if (args.paused !== undefined) body.paused = Boolean(args.paused);
        return createEntity(ctx, args, "tag", body);
      }),
  );

  server.tool(
    "gtm_update_tag",
    `Update a tag. Only pass the fields you want to change.
${UPDATE_MERGE_HINT}
${PARAMETER_ARRAY_HINT}
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      tag_id: z.union([z.string(), z.number()]).describe("Numeric tag ID from gtm_list_entities."),
      name: z.string().optional(),
      type: z.string().optional().describe("Changing a tag's type usually invalidates its parameters."),
      parameters: z.any().optional().describe("REPLACES the existing parameter array wholesale."),
      firing_trigger_id: z.any().optional().describe("REPLACES the existing list — pass all of them."),
      blocking_trigger_id: z.any().optional(),
      tag_firing_option: z.string().optional(),
      paused: z.boolean().optional().describe("true pauses the tag without deleting it — the safest way to stop a tag."),
      parent_folder_id: folderArg,
      notes: notesArg,
      fingerprint: z
        .string()
        .optional()
        .describe("Optional. Supply one you read earlier to fail if the tag changed since."),
      replace: z
        .boolean()
        .optional()
        .describe("Skip merging and send exactly what you supplied. Rarely what you want."),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_update_tag", () => {
        const patch = commonBody(args, "gtm_update_tag");
        if (args.type !== undefined) patch.type = String(args.type);
        const firing = toIdList(args.firing_trigger_id, "firing_trigger_id");
        if (firing) patch.firingTriggerId = firing;
        const blocking = toIdList(args.blocking_trigger_id, "blocking_trigger_id");
        if (blocking) patch.blockingTriggerId = blocking;
        if (args.tag_firing_option) patch.tagFiringOption = String(args.tag_firing_option);
        if (args.paused !== undefined) patch.paused = Boolean(args.paused);
        return updateEntity(ctx, args, "tag", patch, args.tag_id);
      }),
  );

  // -----------------------------------------------------------------------
  // Triggers
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_create_trigger",
    `Create a trigger in a workspace.
${TRIGGER_CONDITION_HINT}
${PARAMETER_ARRAY_HINT}
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      name: z.string().describe('e.g. "CE - generate_lead".'),
      type: z.string().describe('e.g. "customEvent", "formSubmission", "pageview", "click".'),
      custom_event_filter: z
        .any()
        .optional()
        .describe("For type customEvent: the condition matching {{_event}}. See the description."),
      filter: z.any().optional().describe("Extra conditions that must also pass."),
      auto_event_filter: z.any().optional().describe("Conditions for auto-event trigger types."),
      parameters: z.any().optional().describe("Type-specific parameters, e.g. waitForTags, limit."),
      parent_folder_id: folderArg,
      notes: notesArg,
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_create_trigger", () => {
        const body = commonBody(args, "gtm_create_trigger");
        body.type = String(args.type);
        applyTriggerFilters(body, args);
        return createEntity(ctx, args, "trigger", body);
      }),
  );

  server.tool(
    "gtm_update_trigger",
    `Update a trigger. Only pass the fields you want to change.
${UPDATE_MERGE_HINT}
${TRIGGER_CONDITION_HINT}
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      trigger_id: z.union([z.string(), z.number()]).describe("Numeric trigger ID."),
      name: z.string().optional(),
      type: z.string().optional(),
      custom_event_filter: z.any().optional().describe("REPLACES the existing conditions."),
      filter: z.any().optional().describe("REPLACES the existing conditions."),
      auto_event_filter: z.any().optional(),
      parameters: z.any().optional(),
      parent_folder_id: folderArg,
      notes: notesArg,
      fingerprint: z.string().optional(),
      replace: z.boolean().optional(),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_update_trigger", () => {
        const patch = commonBody(args, "gtm_update_trigger");
        if (args.type !== undefined) patch.type = String(args.type);
        applyTriggerFilters(patch, args);
        return updateEntity(ctx, args, "trigger", patch, args.trigger_id);
      }),
  );

  // -----------------------------------------------------------------------
  // Variables
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_create_variable",
    `Create a user-defined variable in a workspace.

To enable a BUILT-IN variable (Page URL, Click Text, Form ID...) use gtm_set_built_in_variables
instead — built-ins are toggled, not created.
${VARIABLE_EXAMPLE_HINT}
${PARAMETER_ARRAY_HINT}
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      name: z.string().describe('e.g. "DLV - form_id". Other entities reference it as {{DLV - form_id}}.'),
      type: z.string().describe('Short type code: "c" Constant, "v" Data Layer, "jsm" Custom JS, "smm" Lookup Table.'),
      parameters: z.any().optional().describe("Type-specific parameters. See the worked example."),
      format_value: z.any().optional().describe("VariableFormatValue object, for case/whitespace conversion."),
      parent_folder_id: folderArg,
      notes: notesArg,
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_create_variable", () => {
        const body = commonBody(args, "gtm_create_variable");
        body.type = String(args.type);
        if (args.format_value !== undefined) {
          body.formatValue = normArray(args.format_value, "format_value")?.[0] ?? args.format_value;
        }
        return createEntity(ctx, args, "variable", body);
      }),
  );

  server.tool(
    "gtm_update_variable",
    `Update a user-defined variable. Only pass the fields you want to change.

RENAMING IS DANGEROUS: other entities reference a variable by its NAME as {{Old Name}}, and GTM
does not rewrite those references for you. Run gtm_find_references before renaming, and update
every referencing entity too.
${UPDATE_MERGE_HINT}
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      variable_id: z.union([z.string(), z.number()]).describe("Numeric variable ID."),
      name: z.string().optional().describe("Renaming breaks {{references}} elsewhere — see above."),
      type: z.string().optional(),
      parameters: z.any().optional().describe("REPLACES the existing parameter array wholesale."),
      format_value: z.any().optional(),
      parent_folder_id: folderArg,
      notes: notesArg,
      fingerprint: z.string().optional(),
      replace: z.boolean().optional(),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_update_variable", () => {
        const patch = commonBody(args, "gtm_update_variable");
        if (args.type !== undefined) patch.type = String(args.type);
        if (args.format_value !== undefined) patch.formatValue = args.format_value;
        return updateEntity(ctx, args, "variable", patch, args.variable_id);
      }),
  );

  // -----------------------------------------------------------------------
  // Folders
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_create_folder",
    `Create a folder in a workspace. Folders are organisational only — they never affect firing.
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      name: z.string(),
      notes: notesArg,
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_create_folder", () => createEntity(ctx, args, "folder", commonBody(args, "gtm_create_folder"))),
  );

  server.tool(
    "gtm_update_folder",
    `Rename a folder or change its notes.
${UPDATE_MERGE_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      folder_id: z.union([z.string(), z.number()]).describe("Numeric folder ID."),
      name: z.string().optional(),
      notes: notesArg,
      fingerprint: z.string().optional(),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_update_folder", () =>
        updateEntity(ctx, args, "folder", commonBody(args, "gtm_update_folder"), args.folder_id),
      ),
  );

  server.tool(
    "gtm_move_entities_to_folder",
    `Move tags, triggers and/or variables into a folder in one call. Pass at least one ID list.

Moving is purely organisational: it does not change what fires, when, or with what parameters.
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      folder_id: z.union([z.string(), z.number()]).describe("Destination folder ID."),
      tag_ids: z.any().optional().describe("List of tag IDs, e.g. ['1','2']."),
      trigger_ids: z.any().optional().describe("List of trigger IDs."),
      variable_ids: z.any().optional().describe("List of variable IDs."),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_move_entities_to_folder", async () => {
        const ids = await resolveIds(ctx, args, { workspace: true });
        const plain = plainIds(ids);
        const tags = toIdList(args.tag_ids, "tag_ids") ?? [];
        const triggers = toIdList(args.trigger_ids, "trigger_ids") ?? [];
        const variables = toIdList(args.variable_ids, "variable_ids") ?? [];
        if (tags.length + triggers.length + variables.length === 0) {
          throw new Error("Pass at least one of tag_ids, trigger_ids or variable_ids.");
        }

        const parts = [
          ...tags.map((v) => `tagId=${encodeURIComponent(v)}`),
          ...triggers.map((v) => `triggerId=${encodeURIComponent(v)}`),
          ...variables.map((v) => `variableId=${encodeURIComponent(v)}`),
        ];
        const url =
          `${entityPath(plain, "folders", args.folder_id)}:move_entities_to_folder?${parts.join("&")}`;

        return mutate(
          ctx,
          {
            op: "move",
            method: "POST",
            url,
            ids: plain,
            entityType: "folder",
            entityId: String(args.folder_id),
            preview: { moving: { tags, triggers, variables } },
          },
          { dryRun: args.dry_run === true },
        );
      }),
  );

  // -----------------------------------------------------------------------
  // Built-in variables
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_set_built_in_variables",
    `Enable and/or disable GTM's built-in variables by type.

Built-ins (Page URL, Click Text, Form ID, Scroll Depth Threshold...) are toggled on and off,
not created. A trigger or tag that references {{Click Text}} does nothing unless CLICK_TEXT is
enabled here first — a very common cause of "my trigger doesn't fire".

Call gtm_get_type_reference with kind="built_in_variable" for the type strings, or
gtm_list_entities with entity_type="built_in_variable" to see what is already on.
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      enable: z.any().optional().describe("List of type strings to enable, e.g. ['CLICK_TEXT','FORM_ID']."),
      disable: z.any().optional().describe("List of type strings to disable."),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_set_built_in_variables", async () => {
        const ids = await resolveIds(ctx, args, { workspace: true });
        const plain = plainIds(ids);
        const enable = (toIdList(args.enable, "enable") ?? []).map((s) => s.toUpperCase());
        const disable = (toIdList(args.disable, "disable") ?? []).map((s) => s.toUpperCase());

        if (enable.length + disable.length === 0) {
          throw new Error("Pass at least one type string in 'enable' or 'disable'.");
        }
        for (const t of [...enable, ...disable]) {
          if (!/^[A-Z_]+$/.test(t)) {
            throw new Error(
              `Invalid built-in variable type ${JSON.stringify(t)}. They are SCREAMING_SNAKE_CASE, ` +
                `e.g. CLICK_TEXT, PAGE_URL, FORM_ID. Call gtm_get_type_reference with ` +
                `kind="built_in_variable" for the list.`,
            );
          }
        }

        const base = collectionPath(plain, "built_in_variables");
        const results: Record<string, unknown> = {};

        if (enable.length) {
          results.enabled = await mutate(
            ctx,
            {
              op: "enable",
              method: "POST",
              url: withRepeatedQuery(base, "type", enable),
              ids: plain,
              entityType: "built_in_variable",
              entityName: enable.join(","),
            },
            { dryRun: args.dry_run === true },
          );
        }
        if (disable.length) {
          results.disabled = await mutate(
            ctx,
            {
              op: "disable",
              method: "DELETE",
              url: withRepeatedQuery(base, "type", disable),
              ids: plain,
              entityType: "built_in_variable",
              entityName: disable.join(","),
            },
            { dryRun: args.dry_run === true },
          );
        }
        return results;
      }),
  );

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_delete_entity",
    `Delete a tag, trigger, variable or folder from a workspace.
${DELETE_HINT}

Consider gtm_update_tag with paused=true instead: it stops a tag firing while keeping its
configuration, and is trivially reversible. Deletion is not.
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      entity_type: z.string().describe(`One of: ${WRITE_ENTITY_TYPES.join(", ")}.`),
      entity_id: z.union([z.string(), z.number()]).describe("Numeric entity ID in THIS workspace."),
      expected_name: z
        .string()
        .optional()
        .describe("Required. The entity's current name — must match, or the delete is refused."),
      confirm: z.boolean().optional().describe("Required. Must be true."),
      force: z
        .boolean()
        .optional()
        .describe("Delete even though other entities still reference it. Breaks them."),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_delete_entity", async () => {
        const ids = await resolveIds(ctx, args, { workspace: true });
        const plain = plainIds(ids);
        const kind = String(args.entity_type).toLowerCase().replace(/s$/, "");
        const meta = entityMeta(kind, { forWrite: true });
        const url = entityPath(plain, meta.collection, args.entity_id);

        // Fetch first, so the confirmation messages can name what is at risk.
        const current = (await gtmGet(ctx, url)) as Record<string, unknown>;
        const actual = {
          name: typeof current.name === "string" ? current.name : undefined,
          id: String(args.entity_id),
          type: kind,
        };

        assertDeleteConfirmed(args, actual);

        if (kind !== "folder") {
          const { references } = await findReferences(ctx, plain, {
            entity_type: kind,
            entity_id: args.entity_id,
          });
          assertNoReferences(args, references, actual);
        }

        await mutate(
          ctx,
          {
            op: "delete",
            method: "DELETE",
            url,
            ids: plain,
            entityType: kind,
            entityId: actual.id,
            entityName: actual.name,
            preview: { deleting: decorate(current) },
          },
          { dryRun: args.dry_run === true },
        );

        return {
          deleted: { type: kind, id: actual.id, name: actual.name },
          note:
            "Removed from the workspace only. The live site is unaffected until a human creates " +
            "a version and publishes. gtm_revert_entity can undo this before then.",
        };
      }),
  );

  // -----------------------------------------------------------------------
  // Revert
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_revert_entity",
    `Undo workspace changes to one entity, restoring it to its state in the live container version.

This is the "put that back" tool. It works for anything changed in the workspace, including
something deleted there — the live version still has it, so reverting brings it back.

It cannot undo a change that has already been published: at that point the live version IS the
change. Only a human can roll that back, in the Tag Manager UI.
${DRY_RUN_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      entity_type: z.string().describe(`One of: ${WRITE_ENTITY_TYPES.join(", ")}.`),
      entity_id: z.union([z.string(), z.number()]).describe("Numeric entity ID."),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true. Reverting discards the workspace edits to this entity."),
      dry_run: dryRunArg,
    },
    (args: any) =>
      guard("gtm_revert_entity", async () => {
        if (args.confirm !== true && args.dry_run !== true) {
          throw new Error(
            "Refusing to revert without confirm=true. This discards the workspace's changes to " +
              "the entity, which may include work a human did. Run gtm_get_workspace_status " +
              "first and show the user what would be discarded.",
          );
        }
        const ids = await resolveIds(ctx, args, { workspace: true });
        const plain = plainIds(ids);
        const kind = String(args.entity_type).toLowerCase().replace(/s$/, "");
        const meta = entityMeta(kind, { forWrite: true });

        return mutate(
          ctx,
          {
            op: "revert" as MutationOp,
            method: "POST",
            url: `${entityPath(plain, meta.collection, args.entity_id)}:revert`,
            ids: plain,
            entityType: kind,
            entityId: String(args.entity_id),
          },
          { dryRun: args.dry_run === true },
        );
      }),
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

function applyTriggerFilters(body: Record<string, unknown>, args: any): void {
  const map: [string, string][] = [
    ["filter", "filter"],
    ["custom_event_filter", "customEventFilter"],
    ["auto_event_filter", "autoEventFilter"],
  ];
  for (const [argKey, apiKey] of map) {
    if (args[argKey] === undefined) continue;
    const list = normArray(args[argKey], argKey);
    if (!list) continue;
    body[apiKey] = list.map((c, i) => {
      const cond = c as Record<string, unknown>;
      if (!cond || typeof cond !== "object") {
        throw new Error(`${argKey}[${i}] must be a Condition object with 'type' and 'parameter'.`);
      }
      const params = toGtmParameters(cond.parameter ?? cond.parameters, `${argKey}[${i}].parameter`);
      if (!params || params.length === 0) {
        throw new Error(
          `${argKey}[${i}] needs a 'parameter' array with exactly two entries, keyed arg0 and ` +
            `arg1. See the tool description for a worked example.`,
        );
      }
      return { type: String(cond.type ?? "EQUALS"), parameter: params };
    });
  }
}
