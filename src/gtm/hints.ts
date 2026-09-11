/**
 * Description fragments, interpolated into tool descriptions.
 *
 * STRINGS ONLY. No logic lives here, on purpose: this is the file that will
 * change most often as we watch the model get things wrong in production, and
 * editing a hint should never be a code review of behaviour.
 *
 * The GA4 worker proved the approach — its tool descriptions carry worked
 * examples for every filter shape, and that is what makes complex parameters
 * usable when the JSON Schema can only say "any".
 */

export const IDS_HINT = `
### IDs
This server has NO default account or container. Every call needs them explicitly.
  account_id    long number, e.g. 6012345678
  container_id  numeric ID (187654321) OR the public ID ("GTM-XXXXXXX"), which this server
                resolves for you via containers:lookup
  workspace_id  numeric. Required for anything that reads or writes workspace contents.

Discovery order when you have nothing: gtm_list_accounts -> gtm_list_containers ->
gtm_list_workspaces. If all you have is a GTM-/G-/AW- ID, start with gtm_lookup_container.

Entity IDs (tag 42, trigger 7) are PER-WORKSPACE and restart at 1 in every container. An ID
copied from another container or workspace points at something unrelated, or at nothing.`;

export const WORKSPACE_HINT = `
### Workspaces
GTM edits never touch the live site directly. They land in a workspace, and a human later
creates a version from it and publishes. This server can do the first half and deliberately
cannot do the second.

This server REFUSES to write to a workspace named "Default Workspace", because that is where
humans leave half-finished work and mixing agent edits into it means their next publish ships
your changes unreviewed. Call gtm_create_workspace with a descriptive name first.`;

export const PARAMETER_ARRAY_HINT = `
### parameters
GTM's parameter array. This is the number-one source of failed GTM writes. Read this.

SHAPE: a list of objects, each with a 'type' and (usually) a 'key'. THE VALUE IS ALWAYS A STRING.

  type:"template"          {"type":"template","key":"eventName","value":"generate_lead"}
      A string. May embed variable references as {{Variable Name}} — the name exactly as it
      appears in gtm_list_entities for variables/built_in_variables, braces included.
  type:"boolean"           {"type":"boolean","key":"sendEcommerceData","value":"false"}
      "true" or "false" AS A STRING. Not the JSON literal true.
  type:"integer"           {"type":"integer","key":"limit","value":"5"}
      Digits AS A STRING.
  type:"tagReference"      {"type":"tagReference","key":"measurementId","value":"Google Tag"}
      The NAME of another tag in this workspace, not its numeric ID, and not a G- ID.
  type:"triggerReference"  {"type":"triggerReference","key":"trigger","value":"12"}
      A trigger ID as a string. Rare — normally use firing_trigger_id instead.
  type:"list"              {"type":"list","key":"eventSettingsTable","list":[ ...parameters... ]}
      Note the 'list' key, NOT 'value'. Entries inside a list have NO 'key' of their own.
  type:"map"               {"type":"map","map":[ ...parameters... ]}
      Note the 'map' key, NOT 'value'. Used as list entries; each child inside HAS a 'key'.

RULES THAT ARE ALWAYS TRUE:
  1. Top-level entries have 'key'. Entries directly inside a 'list' do not.
  2. 'value', 'list' and 'map' are mutually exclusive. Exactly one, matching the type.
  3. Numbers and booleans are strings. Always. "0" not 0, "false" not false.
  4. Variable references are {{Name}}, never {{id}} and never the raw value.

SHORTHAND ACCEPTED: you may pass a flat object instead of the array and this server converts
it. {"eventName":"generate_lead","sendEcommerceData":false} becomes the two-entry array above.
Use shorthand for simple scalar parameters; use the explicit array whenever a list or map is
involved, because shorthand cannot express nesting unambiguously.

WHEN UNSURE: call gtm_get_entity on an existing entity of the same 'type' in this container
and copy its parameter array. That is always more reliable than guessing, and costs one
request. gtm_get_entity also returns a flattened '_parameters' object you can edit and pass
straight back as shorthand.`;

export const TAG_EXAMPLE_HINT = `
### Worked example — GA4 event tag
{
  "name": "GA4 Event - generate_lead",
  "type": "gaawe",
  "firing_trigger_id": ["12"],
  "parameters": [
    {"type": "tagReference", "key": "measurementId", "value": "Google Tag - YourCompany"},
    {"type": "template", "key": "eventName", "value": "generate_lead"},
    {"type": "boolean", "key": "sendEcommerceData", "value": "false"},
    {"type": "list", "key": "eventSettingsTable", "list": [
      {"type": "map", "map": [
        {"type": "template", "key": "parameter", "value": "form_id"},
        {"type": "template", "key": "parameterValue", "value": "{{DLV - form_id}}"}
      ]},
      {"type": "map", "map": [
        {"type": "template", "key": "parameter", "value": "form_name"},
        {"type": "template", "key": "parameterValue", "value": "{{DLV - form_name}}"}
      ]}
    ]}
  ]
}

Notes: "gaawe" is the GA4 Event tag type ("googtag" is the Google Tag; "gaawc" is the older
GA4 Configuration tag, which new containers no longer use). 'measurementId' is a tagReference
to the Google Tag's NAME, not a G- string. 'eventSettingsTable' is the event-parameters table:
a list of two-entry maps keyed 'parameter' / 'parameterValue'.`;

export const VARIABLE_EXAMPLE_HINT = `
### Worked example — Constant variable
Explicit form:
  {"name": "Const - GA4 Measurement ID", "type": "c",
   "parameters": [{"type": "template", "key": "value", "value": "G-XXXXXXXXXX"}]}

Shorthand form, identical result:
  {"name": "Const - GA4 Measurement ID", "type": "c",
   "parameters": {"value": "G-XXXXXXXXXX"}}

Variable type codes are short and opaque: "c" Constant, "v" Data Layer Variable, "jsm" Custom
JavaScript, "smm" Lookup Table, "remm" RegEx Table, "u" URL, "j" JavaScript Variable, "k"
First-Party Cookie, "aev" Auto-Event Variable, "d" DOM Element, "gas" Google Analytics
Settings. Call gtm_get_type_reference for the full table — it costs no API quota.`;

export const TRIGGER_CONDITION_HINT = `
### Trigger conditions — the arg0 / arg1 convention
'filter', 'custom_event_filter' and 'auto_event_filter' are lists of Condition objects. A
Condition has a 'type' (EQUALS, CONTAINS, STARTS_WITH, ENDS_WITH, MATCH_REGEX, CSS_SELECTOR,
LESS, LESS_OR_EQUALS, GREATER, GREATER_OR_EQUALS, and the NOT_ variants) and a parameter array
of EXACTLY TWO entries keyed 'arg0' and 'arg1'. arg0 is the left side, usually a {{variable}};
arg1 is the value to compare against.

  Custom event trigger firing on the dataLayer event "generate_lead":
    "type": "customEvent",
    "custom_event_filter": [{"type":"EQUALS","parameter":[
        {"type":"template","key":"arg0","value":"{{_event}}"},
        {"type":"template","key":"arg1","value":"generate_lead"}]}]

  ...additionally restricted to /pricing pages:
    "filter": [{"type":"CONTAINS","parameter":[
        {"type":"template","key":"arg0","value":"{{Page Path}}"},
        {"type":"template","key":"arg1","value":"/pricing"}]}]

'custom_event_filter' matches the event name; 'filter' adds extra conditions; both must pass.
{{_event}} is the built-in event-name variable and is the arg0 for EVERY customEvent trigger —
do not substitute {{Event}}.

Common trigger types: "pageview", "domReady", "windowLoaded", "click", "linkClick",
"customEvent", "formSubmission", "historyChange", "scrollDepth", "elementVisibility",
"timer", "youTubeVideo", "jsError", "triggerGroup", "always" (fires on every page).`;

export const DRY_RUN_HINT = `
### dry_run
Pass dry_run=true to see the exact HTTP method, URL and request body this server WOULD send,
without changing anything in GTM. All validation, path building, fingerprint fetching,
parameter coercion and merging still run, so a dry run catches a malformed parameter array
just as well as a real call does.

Do this first whenever the user has not yet seen the exact configuration you intend to create.
Note that the server may be deployed with dry-run forced on globally, in which case every
write returns a preview regardless of what you pass — the response says so.`;

export const UPDATE_MERGE_HINT = `
### How updates work here
The Tag Manager API's update is a FULL REPLACE: sending {name, parameter} to change an event
name would silently strip the entity's triggers, folder, notes and everything else.

This server does NOT do that. It reads the entity, merges the fields you supply over the
current state, and writes the merged result back with the fingerprint from that read. So you
only need to pass what you want to change.

  - Arrays you pass (firing_trigger_id, parameters, filter) REPLACE their counterpart
    wholesale — they are not appended to. To add one trigger to a tag that has two, pass all
    three IDs.
  - Pass replace=true to opt out of merging and send exactly what you supplied. Only do this
    when you have just read the entity and are sending back a complete object.
  - If someone edits the entity in the GTM UI between the read and the write, the write fails
    with a fingerprint mismatch rather than clobbering them. That is deliberate; there is no
    automatic retry.

The response includes a 'changed' object listing which top-level fields actually differ from
what was there before, so you can report accurately what you did.`;

export const DELETE_HINT = `
### Deleting safely
Deletion requires all three of:
  confirm=true        an explicit acknowledgement
  expected_name       the entity's current name, which must match. This catches the most
                      likely failure mode by far: a stale or guessed numeric ID pointing at a
                      different entity than the one under discussion.
  no live references   this server checks whether any other tag, trigger or variable
                      references the target, and refuses if so unless you pass force=true.

Call gtm_get_entity first to see the name, and show the user what is about to be deleted
before you confirm on their behalf.

Deletion removes the entity from the WORKSPACE only. The live site is unaffected until a human
creates a version and publishes. gtm_revert_entity undoes a workspace change.`;

export const SUMMARY_HINT = `
### summary
Lists default to summary=true, returning {id, name, type, parentFolderId, firingTriggerId,
notes} per entity. A container with 300 tags is otherwise a very large response, and the Tag
Manager API quota is project-wide and tight. Fetch the full object for the one or two entities
you actually need with gtm_get_entity. Set summary=false only when you genuinely need every
field for every entity.`;

export const NO_PUBLISH_HINT = `
### What this server cannot do
It cannot publish, create or modify container versions, preview, delete a container or a
workspace, manage users, or touch environments. Those are excluded by the OAuth scopes it
holds, not merely by policy, so asking again will not help. Tell the user to do it in the Tag
Manager UI at tagmanager.google.com. Reading versions IS allowed, so you can always report
what is currently live.`;

// ===========================================================================
// The offline type reference, served by gtm_get_type_reference.
// Costs no API quota. Keep it short enough to be readable in a tool result.
// ===========================================================================

export const TYPE_REFERENCE: Record<string, unknown> = {
  tag: {
    note: "Tag 'type' strings. Copy an existing tag of the same type with gtm_get_entity when unsure.",
    common: {
      googtag: "Google tag (the modern base tag). Key param: tagId (e.g. G-XXXXXXX or AW-...).",
      gaawe: "GA4 Event. Params: measurementId (tagReference to the Google tag's NAME), eventName, eventSettingsTable (list of maps), sendEcommerceData (boolean).",
      gaawc: "GA4 Configuration (legacy; new containers use googtag instead).",
      html: "Custom HTML. Params: html (template), supportDocumentWrite (boolean).",
      img: "Custom Image. Params: useCacheBuster (boolean), url (template), cacheBusterQueryParam.",
      sp: "Google Ads Conversion Tracking. Params: conversionId, conversionLabel, orderId, currencyCode.",
      awct: "Google Ads Conversion. Params: conversionId, conversionLabel, orderValue.",
      flc: "Floodlight Counter.",
      cvt_template: "A custom template tag; the suffix is the template id.",
    },
    fields: "name, type, parameter[], firingTriggerId[], blockingTriggerId[], parentFolderId, notes, paused, tagFiringOption (ONCE_PER_EVENT | ONCE_PER_LOAD | UNLIMITED), priority, consentSettings",
  },
  trigger: {
    note: "Trigger 'type' strings. Conditions use the arg0/arg1 convention — see any create/update trigger tool description.",
    common: {
      pageview: "Page View.",
      domReady: "DOM Ready.",
      windowLoaded: "Window Loaded.",
      always: "All Pages / fires on everything.",
      click: "All Elements click.",
      linkClick: "Just Links click. Params: waitForTags, checkValidation, waitForTagsTimeout.",
      formSubmission: "Form Submission. Params: waitForTags, checkValidation.",
      customEvent: "Custom Event. Uses customEventFilter matching {{_event}}.",
      historyChange: "History Change.",
      scrollDepth: "Scroll Depth. Params: verticalScrollPercentageList, horizontalScrollPercentageList.",
      elementVisibility: "Element Visibility. Params: selector, selectorType, visiblePercentageMin.",
      timer: "Timer. Params: interval, limit.",
      youTubeVideo: "YouTube Video.",
      jsError: "JavaScript Error.",
      triggerGroup: "Trigger Group.",
    },
    conditionTypes: [
      "EQUALS", "NOT_EQUALS", "CONTAINS", "NOT_CONTAINS", "STARTS_WITH", "NOT_STARTS_WITH",
      "ENDS_WITH", "NOT_ENDS_WITH", "MATCH_REGEX", "NOT_MATCH_REGEX", "CSS_SELECTOR",
      "LESS", "LESS_OR_EQUALS", "GREATER", "GREATER_OR_EQUALS",
    ],
  },
  variable: {
    note: "User-defined variable 'type' strings. These are short and opaque.",
    common: {
      c: "Constant. Param: value.",
      v: "Data Layer Variable. Params: name (the dataLayer key), dataLayerVersion (integer, use 2), setDefaultValue (boolean), defaultValue.",
      jsm: "Custom JavaScript. Param: javascript (a function expression returning a value).",
      j: "JavaScript Variable (reads a global). Param: name.",
      smm: "Lookup Table. Params: input (template), map (list of maps keyed key/value).",
      remm: "RegEx Table. Params: input, map, fullMatch (boolean), ignoreCase (boolean).",
      u: "URL. Params: component (URL | PROTOCOL | HOST | PATH | QUERY | FRAGMENT), queryKey.",
      k: "First-Party Cookie. Params: name, decodeCookie (boolean).",
      aev: "Auto-Event Variable. Param: varType (ELEMENT | CLASSES | ID | TARGET | TEXT | URL | HISTORY_NEW_URL_FRAGMENT ...).",
      d: "DOM Element. Params: elementSelector, selectorType, attributeName.",
      gas: "Google Analytics Settings.",
      r: "Random Number.",
      e: "Custom Event name.",
      ctv: "Container version number.",
    },
  },
  parameter: {
    types: [
      "template", "boolean", "integer", "list", "map", "tagReference", "triggerReference",
      "typeUnspecified",
    ],
    rules: [
      "Every value is a STRING, including booleans ('true'/'false') and numbers ('5').",
      "type 'list' carries a 'list' key; type 'map' carries a 'map' key; neither carries 'value'.",
      "Entries directly inside a 'list' have no 'key'; entries inside a 'map' must have one.",
      "Variable references are {{Exact Variable Name}}.",
      "tagReference values are another tag's NAME, not its ID.",
    ],
  },
  builtInVariable: {
    note: "Pass these type strings to gtm_set_built_in_variables.",
    common: [
      "PAGE_URL", "PAGE_HOSTNAME", "PAGE_PATH", "REFERRER", "EVENT",
      "CLICK_ELEMENT", "CLICK_CLASSES", "CLICK_ID", "CLICK_TARGET", "CLICK_URL", "CLICK_TEXT",
      "FORM_ELEMENT", "FORM_CLASSES", "FORM_ID", "FORM_TARGET", "FORM_URL", "FORM_TEXT",
      "SCROLL_DEPTH_THRESHOLD", "SCROLL_DEPTH_UNITS", "SCROLL_DIRECTION",
      "NEW_HISTORY_FRAGMENT", "OLD_HISTORY_FRAGMENT", "HISTORY_SOURCE",
      "CONTAINER_ID", "CONTAINER_VERSION", "DEBUG_MODE", "RANDOM_NUMBER",
      "VIDEO_PROVIDER", "VIDEO_STATUS", "VIDEO_URL", "VIDEO_TITLE", "VIDEO_PERCENT",
    ],
  },
};
