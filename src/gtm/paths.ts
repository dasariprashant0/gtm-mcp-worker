/**
 * Resource-path construction and ID validation.
 *
 * Everything here is PURE — no network. The one input that needs a network
 * round trip (a public container ID like GTM-XXXXXXX) is classified here and
 * resolved in http.ts, so this file stays trivially testable and free of
 * import cycles.
 *
 * The GA4 worker's constructPropertyRn() taught the lesson these error
 * messages follow: when an ID is wrong, name the specific mistake the caller
 * probably made. "Invalid container_id" sends the model round in circles;
 * "that is a GA4 measurement ID, call gtm_lookup_container" does not.
 */

export const BASE = "https://tagmanager.googleapis.com/tagmanager/v2";

/** A public container ID (GTM-XXXXXXX) or any other destination ID. */
const PUBLIC_CONTAINER_RE = /^GTM-[A-Z0-9]+$/i;
/** Destination IDs that containers:lookup also accepts. */
const OTHER_DESTINATION_RE = /^(G|AW|DC|GT)-[A-Z0-9-]+$/i;
const NUMERIC_RE = /^\d+$/;

export interface GtmIds {
  accountId: string;
  containerId: string;
  workspaceId?: string;
}

// ===========================================================================
// Scalar coercion
// ===========================================================================

function asScalar(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string") return value.trim();
  return "";
}

/**
 * Pull one ID out of anything that might carry it: a number, a numeric
 * string, or a full/partial resource name such as
 * "accounts/123/containers/456/workspaces/7".
 */
function extractSegment(raw: string, segment: string): string | undefined {
  const m = new RegExp(`(?:^|/)${segment}/(\\d+)(?:/|$)`).exec(raw);
  return m?.[1];
}

function requireNumeric(value: string, label: string, extraHint = ""): string {
  if (NUMERIC_RE.test(value)) return value;
  throw new Error(
    `Invalid ${label}: ${JSON.stringify(value)}. It must be the numeric ID.${extraHint}`,
  );
}

// ===========================================================================
// account_id
// ===========================================================================

export function coerceAccountId(input: unknown): string {
  const raw = asScalar(input);
  if (!raw) {
    throw new Error(
      `account_id is required and this server has no default. Call gtm_list_accounts to see ` +
        `every Tag Manager account this Google account can reach.`,
    );
  }
  const fromPath = extractSegment(raw, "accounts");
  if (fromPath) return fromPath;
  return requireNumeric(
    raw,
    "account_id",
    ` A GTM account ID is a long number visible in the Tag Manager URL as ` +
      `tagmanager.google.com/#/container/accounts/<account_id>/containers/... It is not the ` +
      `account name.`,
  );
}

// ===========================================================================
// container_id — the interesting one
// ===========================================================================

export type ContainerRef =
  | { kind: "numeric"; containerId: string; accountId?: string }
  | { kind: "public"; destinationId: string };

/**
 * Classify a container reference without touching the network.
 *
 * Returns kind "public" for GTM-XXXXXXX and other destination IDs; the caller
 * (resolveContainerRef in http.ts) turns those into numeric IDs via
 * accounts/containers:lookup and caches the result.
 */
export function classifyContainerRef(input: unknown): ContainerRef {
  const raw = asScalar(input);
  if (!raw) {
    throw new Error(
      `container_id is required and this server has no default. Call gtm_list_containers with ` +
        `an account_id to see the containers in an account, or gtm_lookup_container if all you ` +
        `have is a public ID like "GTM-XXXXXXX".`,
    );
  }

  // A full or partial resource name.
  const fromPath = extractSegment(raw, "containers");
  if (fromPath) {
    return { kind: "numeric", containerId: fromPath, accountId: extractSegment(raw, "accounts") };
  }

  if (NUMERIC_RE.test(raw)) return { kind: "numeric", containerId: raw };

  if (PUBLIC_CONTAINER_RE.test(raw)) {
    return { kind: "public", destinationId: raw.toUpperCase() };
  }

  if (OTHER_DESTINATION_RE.test(raw)) {
    const prefix = raw.split("-")[0]!.toUpperCase();
    const what =
      prefix === "G"
        ? "a GA4 measurement ID"
        : prefix === "AW"
          ? "a Google Ads conversion ID"
          : prefix === "DC"
            ? "a Campaign Manager advertiser ID"
            : "a Google tag ID";
    throw new Error(
      `${JSON.stringify(raw)} is ${what}, not a GTM container. If you want the container that ` +
        `holds this tag, call gtm_lookup_container with destination_id=${JSON.stringify(raw)} ` +
        `— it returns the account and container IDs, which you then pass to the other tools.`,
    );
  }

  throw new Error(
    `Invalid container_id: ${JSON.stringify(raw)}. A container is identified either by its ` +
      `numeric ID (e.g. 187654321, visible in the Tag Manager URL as ` +
      `.../accounts/<account>/containers/<container>/...) or by its public ID ` +
      `(e.g. "GTM-XXXXXXX"), which this server resolves for you. It is not the container name.`,
  );
}

// ===========================================================================
// workspace_id
// ===========================================================================

export function coerceWorkspaceId(input: unknown): string {
  const raw = asScalar(input);
  if (!raw || raw.toLowerCase() === "default") {
    throw new Error(
      `workspace_id is required and this server has no default — not even "default". GTM edits ` +
        `always land in a workspace. Call gtm_list_workspaces to see the existing ones, or ` +
        `gtm_create_workspace to make a new one for this change. A dedicated workspace keeps ` +
        `your edits separate from whatever a human has half-finished in the Default Workspace, ` +
        `and this server refuses to write to the Default Workspace for exactly that reason.`,
    );
  }
  const fromPath = extractSegment(raw, "workspaces");
  if (fromPath) return fromPath;
  return requireNumeric(
    raw,
    "workspace_id",
    ` Call gtm_list_workspaces to see the workspaces in this container and their numeric IDs.`,
  );
}

// ===========================================================================
// Path builders
// ===========================================================================

export function accountPath(accountId: string): string {
  return `${BASE}/accounts/${accountId}`;
}

export function containerPath(ids: Pick<GtmIds, "accountId" | "containerId">): string {
  return `${accountPath(ids.accountId)}/containers/${ids.containerId}`;
}

export function workspacePath(ids: GtmIds): string {
  if (!ids.workspaceId) throw new Error("workspacePath called without a workspace_id.");
  return `${containerPath(ids)}/workspaces/${ids.workspaceId}`;
}

export function collectionPath(ids: GtmIds, collection: string): string {
  return `${workspacePath(ids)}/${collection}`;
}

export function entityPath(ids: GtmIds, collection: string, entityId: unknown): string {
  const id = requireNumeric(
    asScalar(entityId),
    "entity_id",
    ` Entity IDs are per-workspace and restart at 1 in every container, so an ID copied from ` +
      `another container or another workspace will point at something unrelated, or at nothing. ` +
      `Call gtm_list_entities in THIS workspace to get the right one.`,
  );
  return `${collectionPath(ids, collection)}/${id}`;
}

/**
 * Cross-check IDs that arrived from two directions. A mismatch is an error,
 * never a silent win for one of them.
 */
export function assertIdsAgree(
  fromPath: string | undefined,
  supplied: string,
  label: string,
): void {
  if (fromPath && fromPath !== supplied) {
    throw new Error(
      `Conflicting ${label}: the resource path you passed says ${fromPath}, but ${label} says ` +
        `${supplied}. Pass the numeric IDs consistently, or pass only the full resource name.`,
    );
  }
}

/** Query-string builder that keeps the allowlist's promises. */
export function withQuery(url: string, params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `${url}?${parts.join("&")}` : url;
}

/** Repeated-key query builder, for ?type=A&type=B and ?tagId=1&tagId=2. */
export function withRepeatedQuery(url: string, key: string, values: readonly string[]): string {
  if (values.length === 0) return url;
  return `${url}?${values.map((v) => `${key}=${encodeURIComponent(v)}`).join("&")}`;
}
