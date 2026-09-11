/**
 * Layer 2 of the safety model: the endpoint allowlist.
 *
 * READ THIS BEFORE EDITING ANY REGEX IN THIS FILE.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SERVER IS ALLOWED TO DO
 * ---------------------------------------------------------------------------
 * Read anything the signed-in user can read, and create/update/delete tags,
 * triggers, variables and folders INSIDE A WORKSPACE. Nothing else.
 *
 * It must never be able to publish, create a container version, delete a
 * container or a workspace, or touch user permissions. A human does those in
 * the GTM UI.
 *
 * ---------------------------------------------------------------------------
 * LAYER 1 — THE OAUTH SCOPE (Google enforces this; our code cannot bypass it)
 * ---------------------------------------------------------------------------
 * This server requests exactly two Tag Manager scopes:
 *
 *     tagmanager.readonly
 *     tagmanager.edit.containers
 *
 * and deliberately NOT edit.containerversions, publish, delete.containers,
 * manage.accounts or manage.users. Per Google's own discovery document, that
 * makes the following impossible regardless of what this file says:
 *
 *     versions:publish              needs tagmanager.publish
 *     workspaces:create_version     needs tagmanager.edit.containerversions
 *     workspaces:quick_preview      needs tagmanager.edit.containerversions
 *     containers DELETE             needs tagmanager.delete.containers
 *     workspaces DELETE             needs tagmanager.delete.containers
 *     user_permissions.*            needs tagmanager.manage.users
 *     accounts PUT                  needs tagmanager.manage.accounts
 *     environments:reauthorize      needs tagmanager.publish
 *
 * That is the strongest guarantee in the system. This file is defence in
 * depth on top of it, because `edit.containers` DOES cover several things we
 * still do not want: creating/updating/combining containers, move_tag_id,
 * versions:set_latest, destinations:link and all of environments.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT THAT DOES ALL THE WORK
 * ---------------------------------------------------------------------------
 * An ID segment is ALWAYS `\d+`. Never `[^/]+`, never `\w+`, never `.+`.
 *
 * `\d+` cannot match a colon. That single choice is what makes
 * `POST .../workspaces/5:create_version` structurally unable to match a
 * pattern ending `workspaces/\d+/tags$` — after the digits, only end-of-string
 * or an explicitly enumerated `?query` is permitted.
 *
 * Corollaries, each of which has bitten someone before:
 *   - Every pattern is anchored `^...$`. An unanchored pattern lets a crafted
 *     ID smuggle in a different path.
 *   - Every `.` in the hostname is escaped. `tagmanager.googleapis.com`
 *     unescaped also matches `tagmanagerXgoogleapis.com`.
 *   - GET may take a permissive-ish query string; POST/PUT/DELETE may not.
 *     For writes the query string is part of the semantics (`?fingerprint=`,
 *     `?type=`), so each write endpoint enumerates the params it accepts.
 *   - The four lists are independent arrays. Never let one list serve two
 *     methods: DELETE on a path GET allows is a catastrophe.
 */

// ===========================================================================
// Building blocks
// ===========================================================================

const B = String.raw`https:\/\/tagmanager\.googleapis\.com\/tagmanager\/v2`;
const ACC = String.raw`accounts\/\d+`;
const CON = String.raw`${ACC}\/containers\/\d+`;
const WS = String.raw`${CON}\/workspaces\/\d+`;

/** Optional pagination query, and nothing else. Reads only. */
const PAGE = String.raw`(\?(pageToken=[A-Za-z0-9._~%-]+|pageSize=\d+)(&(pageToken=[A-Za-z0-9._~%-]+|pageSize=\d+))*)?`;

/** Collections readable inside a workspace. */
export const READ_COLLECTIONS = [
  "tags",
  "triggers",
  "variables",
  "folders",
  "templates",
  "clients",
  "transformations",
  "zones",
  "gtag_config",
] as const;

/**
 * Collections this server may WRITE. Narrower than READ_COLLECTIONS on
 * purpose: templates inject sandboxed JavaScript into the container, and
 * clients/transformations/zones are server-container territory where the
 * shapes are far stranger and a wrong write is expensive.
 */
export const WRITE_COLLECTIONS = ["tags", "triggers", "variables", "folders"] as const;

const READ_C = READ_COLLECTIONS.join("|");
const WRITE_C = WRITE_COLLECTIONS.join("|");

export type WriteCollection = (typeof WRITE_COLLECTIONS)[number];
export type ReadCollection = (typeof READ_COLLECTIONS)[number];

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

// ===========================================================================
// The deny list — checked FIRST, for every method
// ===========================================================================
//
// Redundant with the positive lists by design. It turns "someone added a
// sloppy regex" from a security incident into a thrown error, and it states
// the intent by name so a reviewer scanning this file sees what is forbidden
// without having to mentally evaluate nine regexes.

export const ALWAYS_DENIED: readonly RegExp[] = [
  // Publishing and versioning. The bright line this server does not cross.
  /:publish(\?|$)/,
  /:create_version(\?|$)/,
  /:set_latest(\?|$)/,
  /:undelete(\?|$)/,
  /:quick_preview(\?|$)/,
  // Container-level surgery.
  /:combine(\?|$)/,
  /:move_tag_id(\?|$)/,
  /:import_from_gallery(\?|$)/,
  // Access control and deploy targets.
  /\/user_permissions(\/|\?|$)/,
  /\/environments(\/|\?|$)/,
  /\/destinations(\/|:|\?|$)/,
  /:reauthorize(\?|$)/,
];

// ===========================================================================
// GET — reads
// ===========================================================================

export const ALLOWED_GET: readonly RegExp[] = [
  // Account discovery.
  new RegExp(`^${B}\\/accounts${PAGE}$`),
  new RegExp(`^${B}\\/${ACC}$`),

  // Containers. `accounts/containers:lookup` is a fixed literal path — the
  // segment after /accounts/ is the word "containers", not an ID.
  new RegExp(`^${B}\\/${ACC}\\/containers${PAGE}$`),
  new RegExp(`^${B}\\/${CON}$`),
  new RegExp(`^${B}\\/accounts\\/containers:lookup\\?destination_id=[A-Za-z0-9_-]+$`),
  new RegExp(`^${B}\\/${CON}:snippet$`),

  // Workspaces, and the change list for one workspace.
  new RegExp(`^${B}\\/${CON}\\/workspaces${PAGE}$`),
  new RegExp(`^${B}\\/${WS}$`),
  new RegExp(`^${B}\\/${WS}\\/status$`),

  // Entities inside a workspace: list and get-by-id.
  new RegExp(`^${B}\\/${WS}\\/(${READ_C})${PAGE}$`),
  new RegExp(`^${B}\\/${WS}\\/(${READ_C})\\/\\d+$`),
  new RegExp(`^${B}\\/${WS}\\/built_in_variables${PAGE}$`),

  // Versions — READ ONLY. "What is actually live right now, and how does my
  // workspace differ from it?" is the first question any edit session needs
  // answered; excluding these would make the server less safe, not more.
  // Publishing is a POST on a different path and is denied above.
  new RegExp(`^${B}\\/${CON}\\/version_headers${PAGE}$`),
  new RegExp(`^${B}\\/${CON}\\/version_headers:latest$`),
  new RegExp(`^${B}\\/${CON}\\/versions:live$`),
  new RegExp(`^${B}\\/${CON}\\/versions\\/\\d+$`),
];

// ===========================================================================
// POST — creates, and the handful of colon-verbs we permit
// ===========================================================================
//
// Every entry ends at `$` immediately after its literal final segment. That is
// what keeps `.../workspaces/123:create_version` from matching
// `.../workspaces/123/tags$`. The permitted colon-verbs get their own
// full-literal patterns, so deleting a line here removes that capability
// entirely.

export const ALLOWED_POST: readonly RegExp[] = [
  // Create an entity in a workspace. No query string at all.
  new RegExp(`^${B}\\/${WS}\\/(${WRITE_C})$`),

  // Create a workspace. Note: NOT a container — containers are excluded
  // because the matching delete is scope-blocked, so a mistake would be
  // unfixable by this server.
  new RegExp(`^${B}\\/${CON}\\/workspaces$`),

  // Enable built-in variables. The payload rides in the query string.
  new RegExp(`^${B}\\/${WS}\\/built_in_variables\\?type=[A-Z_]+(&type=[A-Z_]+)*$`),

  // Per-entity undo: restore one entity to its live-version state.
  new RegExp(`^${B}\\/${WS}\\/(${WRITE_C})\\/\\d+:revert$`),
  new RegExp(`^${B}\\/${WS}\\/built_in_variables:revert\\?type=[A-Z_]+$`),

  // Move entities into a folder. Query carries the entity IDs.
  new RegExp(
    `^${B}\\/${WS}\\/folders\\/\\d+:move_entities_to_folder` +
      `(\\?(tagId|triggerId|variableId)=\\d+(&(tagId|triggerId|variableId)=\\d+)*)?$`,
  ),

  // Read-only despite being a POST: lists the entities assigned to a folder.
  new RegExp(`^${B}\\/${WS}\\/folders\\/\\d+:entities${PAGE}$`),

  // Pull live changes into a stale workspace. Reports merge conflicts.
  new RegExp(`^${B}\\/${WS}:sync$`),
];

// ===========================================================================
// PUT — updates
// ===========================================================================
//
// `fingerprint` is GTM's optimistic-concurrency token and the ONLY query
// param permitted on an update.

export const ALLOWED_PUT: readonly RegExp[] = [
  new RegExp(`^${B}\\/${WS}\\/(${WRITE_C})\\/\\d+(\\?fingerprint=[A-Za-z0-9._~%-]+)?$`),
];

// ===========================================================================
// DELETE — the most dangerous verb in the API
// ===========================================================================
//
// In GTM v2 `DELETE {+path}` is ONE method: the same verb deletes a tag and a
// container. The only thing separating "remove a tag" from "remove the
// container" is this list. It enumerates the four workspace-child collections
// and can never terminate at `containers/\d+` or `workspaces/\d+`.

export const ALLOWED_DELETE: readonly RegExp[] = [
  new RegExp(`^${B}\\/${WS}\\/(${WRITE_C})\\/\\d+$`),
  // Disable built-in variables. Payload rides in the query string.
  new RegExp(`^${B}\\/${WS}\\/built_in_variables\\?type=[A-Z_]+(&type=[A-Z_]+)*$`),
];

// ===========================================================================
// The check
// ===========================================================================

const LISTS: Record<HttpMethod, readonly RegExp[]> = {
  GET: ALLOWED_GET,
  POST: ALLOWED_POST,
  PUT: ALLOWED_PUT,
  DELETE: ALLOWED_DELETE,
};

/**
 * Throws unless `url` is explicitly permitted for `method`.
 *
 * Called inside the fetch helpers in http.ts BEFORE a socket is opened, and
 * with the exact string that is then passed to fetch(). Do not normalise the
 * URL between this check and the call — that would be a TOCTOU bug.
 */
export function assertAllowed(url: string, method: HttpMethod): void {
  for (const denied of ALWAYS_DENIED) {
    if (denied.test(url)) {
      throw new Error(
        `Blocked by the GTM MCP deny list: ${method} ${url}\n\n` +
          `This server deliberately cannot publish containers, create or modify container ` +
          `versions, manage user permissions, or touch environments and destinations. Those ` +
          `are human actions to be performed in the Tag Manager UI. This is by design, not a ` +
          `misconfiguration — the OAuth scopes this server holds would not permit most of them ` +
          `even if this check were removed.`,
      );
    }
  }

  const list = LISTS[method];
  // No `default:` fallthrough anywhere in this function. An unknown method
  // must be a TypeScript error, not a silent allow.
  if (!list) {
    throw new Error(`Blocked: unsupported HTTP method ${method} for ${url}.`);
  }

  if (!list.some((re) => re.test(url))) {
    throw new Error(
      `Blocked by the GTM endpoint allowlist: ${method} ${url}\n\n` +
        `This server may only call an explicit list of Tag Manager endpoints. Writes are ` +
        `limited to ${WRITE_COLLECTIONS.join(", ")} inside a workspace. If you are adding a ` +
        `feature, add the endpoint to ALLOWED_${method} in src/gtm/allowlist.ts, add a case to ` +
        `scripts/check-allowlist.ts, and satisfy yourself it cannot publish or destroy anything ` +
        `outside a workspace.`,
    );
  }
}
