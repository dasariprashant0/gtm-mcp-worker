/**
 * Shared plumbing for the tool layer: ID resolution, entity metadata, and the
 * summariser that keeps list responses from blowing the context window.
 */

import type { GtmCtx } from "../../env.ts";
import { READ_COLLECTIONS, WRITE_COLLECTIONS } from "../allowlist.ts";
import { resolveContainerRef } from "../http.ts";
import { classifyContainerRef, coerceAccountId, coerceWorkspaceId, type GtmIds } from "../paths.ts";
import { fromGtmParameters } from "../params.ts";

// ===========================================================================
// Entity metadata
// ===========================================================================

export interface EntityMeta {
  /** URL path segment. */
  collection: string;
  /** Key the Tag Manager API uses for the array in a list response. */
  itemsKey: string;
  /** Field on the resource carrying its numeric ID. */
  idField: string;
  writable: boolean;
}

export const ENTITIES: Record<string, EntityMeta> = {
  tag: { collection: "tags", itemsKey: "tag", idField: "tagId", writable: true },
  trigger: { collection: "triggers", itemsKey: "trigger", idField: "triggerId", writable: true },
  variable: { collection: "variables", itemsKey: "variable", idField: "variableId", writable: true },
  folder: { collection: "folders", itemsKey: "folder", idField: "folderId", writable: true },
  template: { collection: "templates", itemsKey: "template", idField: "templateId", writable: false },
  client: { collection: "clients", itemsKey: "client", idField: "clientId", writable: false },
  transformation: {
    collection: "transformations",
    itemsKey: "transformation",
    idField: "transformationId",
    writable: false,
  },
  zone: { collection: "zones", itemsKey: "zone", idField: "zoneId", writable: false },
  gtag_config: {
    collection: "gtag_config",
    itemsKey: "gtagConfig",
    idField: "gtagConfigId",
    writable: false,
  },
  built_in_variable: {
    collection: "built_in_variables",
    itemsKey: "builtInVariable",
    idField: "type",
    writable: false,
  },
};

export const READ_ENTITY_TYPES = Object.keys(ENTITIES);
export const WRITE_ENTITY_TYPES = Object.keys(ENTITIES).filter((k) => ENTITIES[k]!.writable);

export function entityMeta(entityType: unknown, opts: { forWrite?: boolean } = {}): EntityMeta {
  const key = String(entityType ?? "").trim().toLowerCase().replace(/s$/, "");
  const normalised = key === "gtag_confi" ? "gtag_config" : key;
  const meta = ENTITIES[normalised] ?? ENTITIES[String(entityType ?? "")];

  if (!meta) {
    throw new Error(
      `Unknown entity_type ${JSON.stringify(entityType)}. Valid values are ` +
        `${READ_ENTITY_TYPES.join(", ")}.`,
    );
  }
  if (opts.forWrite && !meta.writable) {
    throw new Error(
      `entity_type "${normalised}" is readable but not writable by this server. Writes are ` +
        `limited to ${WRITE_ENTITY_TYPES.join(", ")}. Custom templates inject sandboxed ` +
        `JavaScript into the container, and clients/transformations/zones are server-container ` +
        `resources where a wrong write is expensive — both are deliberately out of scope. Do ` +
        `those in the Tag Manager UI.`,
    );
  }
  return meta;
}

// Keep the allowlist and this table honest about each other.
const collections = new Set(Object.values(ENTITIES).map((e) => e.collection));
for (const c of READ_COLLECTIONS) {
  if (!collections.has(c)) throw new Error(`ENTITIES is missing read collection "${c}".`);
}
for (const c of WRITE_COLLECTIONS) {
  const meta = Object.values(ENTITIES).find((e) => e.collection === c);
  if (!meta?.writable) throw new Error(`ENTITIES marks writable collection "${c}" as read-only.`);
}

// ===========================================================================
// ID resolution
// ===========================================================================

export interface ResolvedIds extends GtmIds {
  resolvedFrom?: { destinationId: string; via: string };
}

/**
 * Turns whatever the model passed into validated numeric IDs, resolving a
 * public container ID (GTM-XXXXXXX) via containers:lookup if needed.
 *
 * account_id is optional when container_id is a public ID, because the lookup
 * supplies it.
 */
export async function resolveIds(
  ctx: GtmCtx,
  args: { account_id?: unknown; container_id?: unknown; workspace_id?: unknown },
  opts: { workspace?: boolean } = {},
): Promise<ResolvedIds> {
  const ref = classifyContainerRef(args.container_id);
  const suppliedAccount =
    args.account_id === undefined || args.account_id === null || args.account_id === ""
      ? undefined
      : coerceAccountId(args.account_id);

  const resolved = await resolveContainerRef(ctx, ref, suppliedAccount);

  const ids: ResolvedIds = {
    accountId: resolved.accountId,
    containerId: resolved.containerId,
    ...(resolved.resolvedFrom ? { resolvedFrom: resolved.resolvedFrom } : {}),
  };

  if (opts.workspace) ids.workspaceId = coerceWorkspaceId(args.workspace_id);
  return ids;
}

/** Strips the resolution breadcrumb back out for path building. */
export function plainIds(ids: ResolvedIds): GtmIds {
  return {
    accountId: ids.accountId,
    containerId: ids.containerId,
    ...(ids.workspaceId ? { workspaceId: ids.workspaceId } : {}),
  };
}

// ===========================================================================
// Summarising
// ===========================================================================

const SUMMARY_FIELDS = [
  "name",
  "type",
  "notes",
  "paused",
  "parentFolderId",
  "firingTriggerId",
  "blockingTriggerId",
  "tagManagerUrl",
] as const;

/**
 * A container with 300 tags is a very large response, and the Tag Manager API
 * quota is project-wide and tight. Lists return summaries by default; the
 * model escalates to gtm_get_entity for the one or two it actually needs.
 */
export function summarise(item: unknown, meta: EntityMeta): Record<string, unknown> {
  if (!item || typeof item !== "object") return {};
  const src = item as Record<string, unknown>;
  const out: Record<string, unknown> = { id: src[meta.idField] };
  for (const f of SUMMARY_FIELDS) {
    if (src[f] !== undefined) out[f] = src[f];
  }
  return out;
}

/**
 * Full entity, plus a flattened `_parameters` view. The model reads flat and
 * writes flat, and the two representations agree — which is what stops it from
 * having to hand-build the nested parameter array.
 */
export function decorate(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const src = item as Record<string, unknown>;
  const flat = fromGtmParameters(src.parameter);
  return flat ? { ...src, _parameters: flat } : src;
}
