/**
 * Self-check for src/gtm/params.ts.
 *
 * The parameter array is the number-one source of failed GTM writes, and the
 * coercion here is what stands between a model's plausible-looking JSON and a
 * 400 from Google. Run with: node scripts/check-params.ts
 */

import {
  extractVariableReferences,
  fromGtmParameters,
  toGtmParameters,
  toIdList,
} from "../src/gtm/params.ts";

let failures = 0;

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
  }
}

function throws(label: string, fn: () => unknown, mustMention?: string): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (mustMention && !msg.toLowerCase().includes(mustMention.toLowerCase())) {
      failures++;
      console.error(`FAIL  ${label}: threw, but the message never mentions ${JSON.stringify(mustMention)}\n      ${msg}`);
    }
    return;
  }
  failures++;
  console.error(`FAIL  ${label}: expected a throw, got none`);
}

// --- Flat shorthand -> Parameter[] -----------------------------------------

eq(
  "string becomes template",
  toGtmParameters({ eventName: "generate_lead" }),
  [{ type: "template", key: "eventName", value: "generate_lead" }],
);

eq(
  "JSON boolean becomes a STRING-valued boolean parameter",
  toGtmParameters({ sendEcommerceData: false }),
  [{ type: "boolean", key: "sendEcommerceData", value: "false" }],
);

eq(
  "integer becomes a STRING-valued integer parameter",
  toGtmParameters({ limit: 5 }),
  [{ type: "integer", key: "limit", value: "5" }],
);

eq(
  "nested object becomes a map whose children keep their keys",
  toGtmParameters({ settings: { a: "1", b: true } }),
  [
    {
      type: "map",
      key: "settings",
      map: [
        { type: "template", key: "a", value: "1" },
        { type: "boolean", key: "b", value: "true" },
      ],
    },
  ],
);

eq(
  "array becomes a list whose entries have NO key",
  toGtmParameters({ table: [{ parameter: "form_id", parameterValue: "{{DLV - form_id}}" }] }),
  [
    {
      type: "list",
      key: "table",
      list: [
        {
          type: "map",
          map: [
            { type: "template", key: "parameter", value: "form_id" },
            { type: "template", key: "parameterValue", value: "{{DLV - form_id}}" },
          ],
        },
      ],
    },
  ],
);

// --- Explicit Parameter[] ---------------------------------------------------

eq(
  "a JSON string is parsed",
  toGtmParameters('[{"type":"template","key":"value","value":"G-XXX"}]'),
  [{ type: "template", key: "value", value: "G-XXX" }],
);

eq(
  "JSON-literal booleans inside an explicit array are stringified",
  toGtmParameters([{ type: "boolean", key: "x", value: true }]),
  [{ type: "boolean", key: "x", value: "true" }],
);

eq(
  "tagReference survives untouched",
  toGtmParameters([{ type: "tagReference", key: "measurementId", value: "Google Tag" }]),
  [{ type: "tagReference", key: "measurementId", value: "Google Tag" }],
);

eq(
  "a stray key inside a list entry is stripped",
  toGtmParameters([{ type: "list", key: "t", list: [{ type: "template", key: "nope", value: "v" }] }]),
  [{ type: "list", key: "t", list: [{ type: "template", value: "v" }] }],
);

eq(
  "snake_case keys are accepted",
  toGtmParameters([{ type: "template", key: "a", value: "b", is_weak_reference: true }]),
  [{ type: "template", key: "a", value: "b", isWeakReference: true }],
);

eq(
  "an entry with no type at all is inferred rather than rejected",
  toGtmParameters([{ key: "eventName", value: "purchase" }]),
  [{ type: "template", key: "eventName", value: "purchase" }],
);

// --- The GA4 worked example from the tool description must validate ---------

const GA4_TAG_PARAMS = [
  { type: "tagReference", key: "measurementId", value: "Google Tag - YourCompany" },
  { type: "template", key: "eventName", value: "generate_lead" },
  { type: "boolean", key: "sendEcommerceData", value: "false" },
  {
    type: "list",
    key: "eventSettingsTable",
    list: [
      {
        type: "map",
        map: [
          { type: "template", key: "parameter", value: "form_id" },
          { type: "template", key: "parameterValue", value: "{{DLV - form_id}}" },
        ],
      },
    ],
  },
];
eq("the documented GA4 event tag example round-trips unchanged", toGtmParameters(GA4_TAG_PARAMS), GA4_TAG_PARAMS);

// --- Errors that must be caught BEFORE the network call ---------------------

throws("list carrying 'value' is rejected", () => toGtmParameters([{ type: "list", key: "t", value: "x" }]), "list");
throws("map carrying 'value' is rejected", () => toGtmParameters([{ type: "map", key: "t", value: "x" }]), "map");
throws("unknown type is rejected", () => toGtmParameters([{ type: "stringy", key: "t", value: "x" }]), "unknown parameter type");
throws("scalar with an object value is rejected", () => toGtmParameters([{ type: "template", key: "t", value: { a: 1 } }]), "list");
throws("a non-JSON string is rejected", () => toGtmParameters("not json at all"), "must be an array");

// --- Flatten, and the round trip that makes read-then-write work ------------

eq(
  "flatten turns strings, booleans and integers back into native types",
  fromGtmParameters([
    { type: "template", key: "eventName", value: "x" },
    { type: "boolean", key: "b", value: "true" },
    { type: "integer", key: "n", value: "7" },
  ]),
  { eventName: "x", b: true, n: 7 },
);

eq(
  "flatten unwraps a list of maps into an array of objects",
  fromGtmParameters(GA4_TAG_PARAMS),
  {
    measurementId: "Google Tag - YourCompany",
    eventName: "generate_lead",
    sendEcommerceData: false,
    eventSettingsTable: [{ parameter: "form_id", parameterValue: "{{DLV - form_id}}" }],
  },
);

eq(
  "read-flatten-then-write round-trips to the same parameter array",
  toGtmParameters(fromGtmParameters(GA4_TAG_PARAMS)),
  [
    { type: "template", key: "measurementId", value: "Google Tag - YourCompany" },
    { type: "template", key: "eventName", value: "generate_lead" },
    { type: "boolean", key: "sendEcommerceData", value: "false" },
    {
      type: "list",
      key: "eventSettingsTable",
      list: [
        {
          type: "map",
          map: [
            { type: "template", key: "parameter", value: "form_id" },
            { type: "template", key: "parameterValue", value: "{{DLV - form_id}}" },
          ],
        },
      ],
    },
  ],
);
// NOTE: measurementId comes back as "template", not "tagReference" — flattening
// is lossy about reference types. That is why gtm_get_entity returns BOTH the
// raw parameter array and the flattened view, and why the hint tells the model
// to copy the raw array when references are involved.

// --- Variable references ----------------------------------------------------

eq(
  "variable references are found at every depth",
  extractVariableReferences(GA4_TAG_PARAMS as never).sort(),
  ["DLV - form_id"],
);

// --- ID lists ---------------------------------------------------------------

eq("comma string becomes an ID list", toIdList("1, 2,3", "x"), ["1", "2", "3"]);
eq("numbers become strings", toIdList([1, 2], "x"), ["1", "2"]);
eq("a bare number becomes a single-item list", toIdList(12, "x"), ["12"]);
eq("a JSON array string is parsed", toIdList('["4","5"]', "x"), ["4", "5"]);

if (failures > 0) {
  console.error(`\nparams check: ${failures} FAILED`);
  process.exit(1);
}
console.log("params check: all passed");
