/**
 * Read tools. Everything here is a GET (plus folders:entities, which is a POST
 * that only reads), satisfied by the tagmanager.readonly scope.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GtmCtx } from "../../env.ts";
import { gtmGet, gtmGetPaged } from "../http.ts";
import {
  IDS_HINT,
  NO_PUBLISH_HINT,
  PARAMETER_ARRAY_HINT,
  SUMMARY_HINT,
  TYPE_REFERENCE,
  WORKSPACE_HINT,
} from "../hints.ts";
import {
  BASE,
  collectionPath,
  containerPath,
  entityPath,
  workspacePath,
} from "../paths.ts";
import { extractVariableReferences, type GtmParameter } from "../params.ts";
import { makeGuard } from "../safety.ts";
import {
  ENTITIES,
  READ_ENTITY_TYPES,
  decorate,
  entityMeta,
  plainIds,
  resolveIds,
  summarise,
} from "./common.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const accountArg = z
  .union([z.string(), z.number()])
  .optional()
  .describe("GTM account ID, e.g. 6012345678. Optional only when container_id is a GTM-XXXXXXX public ID.");

const containerArg = z
  .union([z.string(), z.number()])
  .describe('Container ID: numeric (187654321) or public ("GTM-XXXXXXX"), which is resolved for you.');

const workspaceArg = z
  .union([z.string(), z.number()])
  .describe("Workspace ID. Required — there is no default. See gtm_list_workspaces.");

export function registerReadTools(server: McpServer, ctx: GtmCtx): void {
  // Bound once: every guard() below then times and records its tool call.
  const guard = makeGuard(ctx);

  // -----------------------------------------------------------------------
  // gtm_list_accounts
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_list_accounts",
    `List every Google Tag Manager account the signed-in Google account can see. Start here when
you have no IDs at all.

Each result has an accountId you pass to gtm_list_containers. If this comes back empty, the
signed-in user genuinely has no GTM access — that is a permissions matter in Tag Manager, not
a problem with this server.
${NO_PUBLISH_HINT}`,
    {},
    () =>
      guard("gtm_list_accounts", async () => {
        const page = await gtmGetPaged(ctx, `${BASE}/accounts`, "account");
        return { accounts: page.items, truncated: page.truncated };
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_list_containers
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_list_containers",
    `List the containers in a GTM account, with both the numeric containerId and the public ID
(publicId, the GTM-XXXXXXX string people actually recognise), plus usageContext which tells you
whether it is a web, server, iOS, AMP or Android container.

Use this to confirm which container you are about to touch before doing anything else.`,
    {
      account_id: z
        .union([z.string(), z.number()])
        .describe("GTM account ID from gtm_list_accounts."),
    },
    (args: any) =>
      guard("gtm_list_containers", async () => {
        const ids = { accountId: String(args.account_id).match(/\d+/)?.[0] ?? "" };
        if (!ids.accountId) throw new Error("account_id must be numeric. See gtm_list_accounts.");
        const page = await gtmGetPaged(ctx, `${BASE}/accounts/${ids.accountId}/containers`, "container");
        return { containers: page.items, truncated: page.truncated };
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_lookup_container
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_lookup_container",
    `Resolve a destination ID to the account and container that holds it. This is how you answer
"which container has our GA4 tag in it?" when all you have is an ID off a web page.

Accepts a GTM container public ID ("GTM-XXXXXXX"), a GA4 measurement ID ("G-XXXXXXXXXX"), a
Google Ads conversion ID ("AW-..."), or a Google tag ID ("GT-...").

You usually do not need to call this explicitly: every other tool accepts a GTM-XXXXXXX public
ID directly as container_id and resolves it for you.`,
    {
      destination_id: z
        .string()
        .describe('e.g. "GTM-XXXXXXX", "G-XXXXXXXXXX", "AW-123456789".'),
    },
    (args: any) =>
      guard("gtm_lookup_container", () =>
        gtmGet(
          ctx,
          `${BASE}/accounts/containers:lookup?destination_id=${encodeURIComponent(
            String(args.destination_id).trim(),
          )}`,
        ),
      ),
  );

  // -----------------------------------------------------------------------
  // gtm_get_container
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_get_container",
    `One container in detail: public ID, name, usage context (web / server / amp / ios / android),
domain names, tagging server URLs, and the destination IDs it serves.
${IDS_HINT}`,
    { account_id: accountArg, container_id: containerArg },
    (args: any) =>
      guard("gtm_get_container", async () => {
        const ids = await resolveIds(ctx, args);
        const body = await gtmGet(ctx, containerPath(plainIds(ids)));
        return ids.resolvedFrom ? { ...(body as object), _resolved_from: ids.resolvedFrom } : body;
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_get_container_snippet
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_get_container_snippet",
    `The installation snippet for a container — the <script> block for a web container, or the
configuration string for a server container. Useful when checking that what is on the site
matches what is in Tag Manager.`,
    { account_id: accountArg, container_id: containerArg },
    (args: any) =>
      guard("gtm_get_container_snippet", async () => {
        const ids = await resolveIds(ctx, args);
        return gtmGet(ctx, `${containerPath(plainIds(ids))}:snippet`);
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_list_workspaces
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_list_workspaces",
    `List the workspaces in a container. Every read of workspace contents and every write needs a
workspace_id, and this server has no default.
${WORKSPACE_HINT}`,
    { account_id: accountArg, container_id: containerArg },
    (args: any) =>
      guard("gtm_list_workspaces", async () => {
        const ids = await resolveIds(ctx, args);
        const page = await gtmGetPaged(
          ctx,
          `${containerPath(plainIds(ids))}/workspaces`,
          "workspace",
        );
        return { workspaces: page.items, truncated: page.truncated };
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_get_workspace_status
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_get_workspace_status",
    `The uncommitted changes in a workspace, compared with the live version — i.e. your diff. Also
reports merge conflicts if the live version has moved on since the workspace was created.

This is the highest-value read tool here. Call it before you start editing (to see what a human
already has in flight) and again after you finish (to report exactly what you staged). It is
also what the human will review before publishing, so its contents are the real deliverable of
any editing session.

An empty workspaceChange list means the workspace is identical to the live version.`,
    { account_id: accountArg, container_id: containerArg, workspace_id: workspaceArg },
    (args: any) =>
      guard("gtm_get_workspace_status", async () => {
        const ids = await resolveIds(ctx, args, { workspace: true });
        return gtmGet(ctx, `${workspacePath(plainIds(ids))}/status`);
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_list_entities
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_list_entities",
    `List entities of one type inside a workspace. The workhorse read tool.

entity_type is one of: ${READ_ENTITY_TYPES.join(", ")}.
${SUMMARY_HINT}
${IDS_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      entity_type: z
        .string()
        .describe(`One of: ${READ_ENTITY_TYPES.join(", ")}.`),
      summary: z
        .boolean()
        .optional()
        .describe("Default true. Set false to return every field of every entity — expensive."),
      name_contains: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on the entity name, applied server-side here."),
    },
    (args: any) =>
      guard("gtm_list_entities", async () => {
        const ids = await resolveIds(ctx, args, { workspace: true });
        const meta = entityMeta(args.entity_type);
        const page = await gtmGetPaged(
          ctx,
          collectionPath(plainIds(ids), meta.collection),
          meta.itemsKey,
        );

        let items = page.items;
        if (typeof args.name_contains === "string" && args.name_contains.trim()) {
          const needle = args.name_contains.trim().toLowerCase();
          items = items.filter((i) =>
            String((i as Record<string, unknown>).name ?? "").toLowerCase().includes(needle),
          );
        }

        const wantSummary = args.summary !== false;
        return {
          entity_type: args.entity_type,
          count: items.length,
          truncated: page.truncated,
          items: wantSummary ? items.map((i) => summarise(i, meta)) : items.map(decorate),
          ...(wantSummary
            ? { note: "Summarised. Call gtm_get_entity for the full object including parameters." }
            : {}),
        };
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_get_entity
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_get_entity",
    `Fetch one entity in full, including its 'fingerprint' and its 'parameter' array.

The response also carries a flattened '_parameters' object — the same parameters as plain
key/value pairs. You can edit that object and pass it straight back as the 'parameters'
argument of an update or create call, which is far more reliable than hand-building the nested
array.

When you are about to create something and are unsure of the shape, call this on an existing
entity of the same 'type' and copy it. One request beats three failed guesses.
${PARAMETER_ARRAY_HINT}`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      entity_type: z.string().describe(`One of: ${READ_ENTITY_TYPES.join(", ")}.`),
      entity_id: z
        .union([z.string(), z.number()])
        .describe("Numeric entity ID, per-workspace. From gtm_list_entities."),
    },
    (args: any) =>
      guard("gtm_get_entity", async () => {
        const ids = await resolveIds(ctx, args, { workspace: true });
        const meta = entityMeta(args.entity_type);
        const body = await gtmGet(
          ctx,
          entityPath(plainIds(ids), meta.collection, args.entity_id),
        );
        return decorate(body);
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_find_references
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_find_references",
    `Find everything in a workspace that references a given variable name, trigger, or tag.

Run this before deleting or renaming anything. GTM has no referential integrity: deleting a
variable that twelve tags use does not warn you, it just leaves twelve broken tags that fail
silently on the live site after the next publish.

Searches: {{Variable Name}} references inside every tag/trigger/variable parameter, firing and
blocking trigger assignments, setup/teardown tag relationships, and raw ID matches.

Pass either 'query' (a variable name, with or without braces) or entity_type + entity_id.
This costs three API requests, so it is worth calling once and reusing the answer.`,
    {
      account_id: accountArg,
      container_id: containerArg,
      workspace_id: workspaceArg,
      query: z
        .string()
        .optional()
        .describe('A variable name, e.g. "DLV - form_id" or "{{DLV - form_id}}".'),
      entity_type: z.string().optional().describe("Alternative to query: tag, trigger or variable."),
      entity_id: z.union([z.string(), z.number()]).optional().describe("Used with entity_type."),
    },
    (args: any) =>
      guard("gtm_find_references", async () => {
        const ids = await resolveIds(ctx, args, { workspace: true });
        return findReferences(ctx, plainIds(ids), args);
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_list_versions
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_list_versions",
    `List the container's version headers: ID, name, who published it and when, and how many tags,
triggers and variables each contains.

READ ONLY. This server cannot create, modify or publish a version.
${NO_PUBLISH_HINT}`,
    { account_id: accountArg, container_id: containerArg },
    (args: any) =>
      guard("gtm_list_versions", async () => {
        const ids = await resolveIds(ctx, args);
        const page = await gtmGetPaged(
          ctx,
          `${containerPath(plainIds(ids))}/version_headers`,
          "containerVersionHeader",
        );
        return { versions: page.items, truncated: page.truncated };
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_get_version
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_get_version",
    `Fetch one container version — or pass version_id="live" for whatever is currently published.

"What is actually live on the site right now?" is usually the first question worth answering,
and the only reliable way to answer it: a workspace shows what someone INTENDS to publish, not
what visitors are currently getting. Compare against gtm_get_workspace_status to see the delta.

SUMMARISED BY DEFAULT. A container version contains every tag, trigger and variable in full —
for a real container that is hundreds of thousands of characters, far past what one tool result
can carry. So this returns version metadata plus an id/name/type index of its contents. That is
what you want for "what is live" and "does the live version contain tag X".

Set summary=false ONLY for a container you already know is small, or after narrowing with
entity_type. To read one entity's full configuration, take its ID from the index here and call
gtm_get_entity against a workspace.

READ ONLY — fetching a version does not publish, restore or alter anything.`,
    {
      account_id: accountArg,
      container_id: containerArg,
      version_id: z
        .union([z.string(), z.number()])
        .describe('Numeric version ID, or the string "live" for the currently published version.'),
      summary: z
        .boolean()
        .optional()
        .describe("Default true. false returns the full version and will often be too large."),
      entity_type: z
        .string()
        .optional()
        .describe("Restrict the index to one type, e.g. 'tag'. Omit for all types."),
      name_contains: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on entity names within the version."),
    },
    (args: any) =>
      guard("gtm_get_version", async () => {
        const ids = await resolveIds(ctx, args);
        const base = containerPath(plainIds(ids));
        const raw = String(args.version_id).trim().toLowerCase();

        let url: string;
        if (raw === "live" || raw === "published") {
          url = `${base}/versions:live`;
        } else if (raw === "latest") {
          url = `${base}/version_headers:latest`;
        } else if (/^\d+$/.test(raw)) {
          url = `${base}/versions/${raw}`;
        } else {
          throw new Error(
            `version_id must be numeric, or "live" for the published version, or "latest" for ` +
              `the most recently created one. Call gtm_list_versions to see the IDs.`,
          );
        }

        const version = (await gtmGet(ctx, url)) as Record<string, unknown>;
        if (args.summary === false) return version;
        return summariseVersion(version, args);
      }),
  );

  // -----------------------------------------------------------------------
  // gtm_get_type_reference
  // -----------------------------------------------------------------------
  server.tool(
    "gtm_get_type_reference",
    `Offline reference for GTM's opaque type codes and parameter rules. Costs NO API quota —
nothing is fetched. Call it freely before writing anything.

GTM identifies entity kinds with short strings that are impossible to guess: a Constant
variable is type "c", a Data Layer Variable is "v", a GA4 Event tag is "gaawe". This returns
the common ones with the parameter keys each expects.

kind: "tag" | "trigger" | "variable" | "parameter" | "built_in_variable" | "all"`,
    {
      kind: z
        .string()
        .optional()
        .describe('Default "all". One of tag, trigger, variable, parameter, built_in_variable, all.'),
    },
    (args: any) =>
      guard("gtm_get_type_reference", async () => {
        const kind = String(args.kind ?? "all").trim().toLowerCase();
        if (kind === "all" || !kind) return TYPE_REFERENCE;
        const key = kind === "built_in_variable" ? "builtInVariable" : kind;
        const section = TYPE_REFERENCE[key];
        if (!section) {
          throw new Error(
            `Unknown kind ${JSON.stringify(args.kind)}. Valid: tag, trigger, variable, ` +
              `parameter, built_in_variable, all.`,
          );
        }
        return { [key]: section };
      }),
  );
}

// ===========================================================================
// gtm_find_references implementation
// ===========================================================================

interface Reference {
  type: string;
  id: string;
  name: string;
  why: string;
}

export async function findReferences(
  ctx: GtmCtx,
  ids: { accountId: string; containerId: string; workspaceId?: string },
  args: { query?: unknown; entity_type?: unknown; entity_id?: unknown },
): Promise<{ target: unknown; reference_count: number; references: Reference[] }> {
  let name = typeof args.query === "string" ? args.query.trim() : "";
  let targetType = "";
  let targetId = "";

  if (args.entity_type !== undefined && args.entity_id !== undefined) {
    const meta = entityMeta(args.entity_type);
    targetType = String(args.entity_type).toLowerCase().replace(/s$/, "");
    targetId = String(args.entity_id);
    const entity = (await gtmGet(
      ctx,
      entityPath(ids, meta.collection, args.entity_id),
    )) as Record<string, unknown>;
    name = String(entity.name ?? name);
  }

  const bare = name.replace(/^\{\{|\}\}$/g, "").trim();
  if (!bare && !targetId) {
    throw new Error(
      "Pass either query (a variable or entity name) or entity_type + entity_id.",
    );
  }

  const [tags, triggers, variables] = await Promise.all([
    gtmGetPaged(ctx, `${collectionPath(ids, "tags")}`, "tag"),
    gtmGetPaged(ctx, `${collectionPath(ids, "triggers")}`, "trigger"),
    gtmGetPaged(ctx, `${collectionPath(ids, "variables")}`, "variable"),
  ]);

  const refs: Reference[] = [];

  const scan = (items: unknown[], kind: "tag" | "trigger" | "variable"): void => {
    const meta = ENTITIES[kind]!;
    for (const raw of items) {
      const e = raw as Record<string, unknown>;
      const id = String(e[meta.idField] ?? "");
      const eName = String(e.name ?? "");
      // Don't report the target as referencing itself.
      if (kind === targetType && id === targetId) continue;

      const reasons: string[] = [];

      if (bare) {
        const used = extractVariableReferences(e.parameter as GtmParameter[] | undefined);
        if (used.some((u) => u.toLowerCase() === bare.toLowerCase())) {
          reasons.push(`uses {{${bare}}} in its parameters`);
        }
      }

      if (targetType === "trigger" && targetId) {
        if ((e.firingTriggerId as string[] | undefined)?.includes(targetId)) {
          reasons.push("fires on this trigger");
        }
        if ((e.blockingTriggerId as string[] | undefined)?.includes(targetId)) {
          reasons.push("is blocked by this trigger");
        }
      }

      if (targetType === "tag" && targetId) {
        const related = [
          ...((e.setupTag as { tagName?: string }[] | undefined) ?? []),
          ...((e.teardownTag as { tagName?: string }[] | undefined) ?? []),
        ];
        if (related.some((r) => r.tagName && r.tagName.toLowerCase() === bare.toLowerCase())) {
          reasons.push("has this tag as a setup/teardown tag");
        }
      }

      for (const why of reasons) refs.push({ type: kind, id, name: eName, why });
    }
  };

  scan(tags.items, "tag");
  scan(triggers.items, "trigger");
  scan(variables.items, "variable");

  return {
    target: { name: bare || undefined, type: targetType || undefined, id: targetId || undefined },
    reference_count: refs.length,
    references: refs,
  };
}

// ===========================================================================
// Version summarising
// ===========================================================================

/** The entity collections a ContainerVersion carries inline. */
const VERSION_COLLECTIONS: [key: string, idField: string][] = [
  ["tag", "tagId"],
  ["trigger", "triggerId"],
  ["variable", "variableId"],
  ["folder", "folderId"],
  ["builtInVariable", "type"],
  ["customTemplate", "templateId"],
  ["client", "clientId"],
  ["zone", "zoneId"],
  ["gtagConfig", "gtagConfigId"],
  ["transformation", "transformationId"],
];

/**
 * A ContainerVersion inlines every entity in full. On a real container that is
 * hundreds of thousands of characters — more than a single tool result can
 * carry, and a waste of context even when it fits. So return the metadata plus
 * an id/name/type index, the same bargain gtm_list_entities makes.
 */
export function summariseVersion(
  version: Record<string, unknown>,
  opts: { entity_type?: unknown; name_contains?: unknown } = {},
): Record<string, unknown> {
  const wanted =
    typeof opts.entity_type === "string" && opts.entity_type.trim()
      ? entityMeta(opts.entity_type).itemsKey
      : undefined;

  const needle =
    typeof opts.name_contains === "string" && opts.name_contains.trim()
      ? opts.name_contains.trim().toLowerCase()
      : undefined;

  const counts: Record<string, number> = {};
  const contents: Record<string, unknown[]> = {};

  for (const [key, idField] of VERSION_COLLECTIONS) {
    const list = version[key];
    if (!Array.isArray(list)) continue;
    counts[key] = list.length;
    if (wanted && key !== wanted) continue;

    const rows = list
      .map((raw) => {
        const e = raw as Record<string, unknown>;
        return {
          id: e[idField],
          name: e.name,
          ...(e.type !== undefined ? { type: e.type } : {}),
          ...(e.paused === true ? { paused: true } : {}),
          ...(Array.isArray(e.firingTriggerId) ? { firingTriggerId: e.firingTriggerId } : {}),
        };
      })
      .filter((r) => !needle || String(r.name ?? "").toLowerCase().includes(needle));

    contents[key] = rows;
  }

  return {
    containerVersionId: version.containerVersionId,
    name: version.name,
    description: version.description,
    deleted: version.deleted,
    fingerprint: version.fingerprint,
    tagManagerUrl: version.tagManagerUrl,
    container: version.container,
    counts,
    contents,
    _summarised: true,
    _note:
      "Summarised: entity parameters are omitted because a full container version exceeds what " +
      "one tool result can carry. Take an ID from 'contents' and call gtm_get_entity against a " +
      "workspace for that entity's full configuration, or narrow with entity_type/name_contains.",
  };
}
