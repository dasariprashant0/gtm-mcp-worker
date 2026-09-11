/**
 * GTM's `parameter` array — the single biggest source of failed writes.
 *
 * A tag, trigger or variable carries a list of Parameter objects shaped
 * {type, key, value | list | map}. There are EIGHT types, not five: beyond
 * template/boolean/integer/list/map there are tagReference, triggerReference
 * and typeUnspecified. A modern GA4 event tag references its Google Tag with
 * type:"tagReference", and a model that only knows the five common types will
 * emit type:"template" there and get either a confusing 400 or a tag that
 * silently does nothing.
 *
 * This module exists so the model can work in a FLAT representation in both
 * directions — read tools return `_parameters` flattened, write tools accept
 * a flat object — and never has to hand-build the nested array for the common
 * case. The reciprocity is the point: the model's mental model of a tag
 * becomes the flat one, and the two representations agree.
 */

export interface GtmParameter {
  type: string;
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
  isWeakReference?: boolean;
}

export const PARAMETER_TYPES = [
  "template",
  "boolean",
  "integer",
  "list",
  "map",
  "tagReference",
  "triggerReference",
  "typeUnspecified",
] as const;

const SCALAR_TYPES = new Set(["template", "boolean", "integer", "tagReference", "triggerReference"]);

// ===========================================================================
// Tolerant input coercion (ported from the GA4 worker)
// ===========================================================================
//
// Tool params are declared z.any(), because nested zod emits JSON Schema whose
// `additionalProperties` is an object rather than a boolean, which some MCP
// clients mishandle. The cost is that clients get no type hint, and some
// serialise the value to a JSON string. Hence this.

export function parseIfJsonString(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(
      `${label} looks like JSON but could not be parsed. Pass it as a real object/array, not a ` +
        `string containing JSON.`,
    );
  }
}

export function normArray(value: unknown, label: string): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = parseIfJsonString(value, label);
  if (Array.isArray(parsed)) return parsed;
  // A single object where a list was expected is a common and harmless slip.
  if (typeof parsed === "object") return [parsed];
  throw new Error(`${label} must be a LIST. Received ${typeof parsed}.`);
}

export function normObj(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = parseIfJsonString(value, label);
  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error(`${label} must be an OBJECT. Received ${Array.isArray(parsed) ? "array" : typeof parsed}.`);
}

export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Accepts ["1","2"], [1,2], "1,2", 1, or "1" and returns string IDs. */
export function toIdList(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return [String(value)];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("[")) return toIdList(parseIfJsonString(trimmed, label), label);
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === "number") return String(v);
      if (typeof v === "string") return v.trim();
      throw new Error(`${label} must be a list of IDs. Found ${typeof v}.`);
    });
  }
  throw new Error(`${label} must be a list of IDs.`);
}

// ===========================================================================
// Flat object  ->  Parameter[]
// ===========================================================================

function inferFromValue(key: string | undefined, value: unknown, label: string): GtmParameter {
  if (typeof value === "string") return { type: "template", ...(key ? { key } : {}), value };
  if (typeof value === "boolean") {
    return { type: "boolean", ...(key ? { key } : {}), value: String(value) };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "integer", ...(key ? { key } : {}), value: String(value) }
      : { type: "template", ...(key ? { key } : {}), value: String(value) };
  }
  if (Array.isArray(value)) {
    return {
      type: "list",
      ...(key ? { key } : {}),
      // Entries directly inside a list carry no key of their own.
      list: value.map((entry) => inferFromValue(undefined, entry, label)),
    };
  }
  if (value && typeof value === "object") {
    return {
      type: "map",
      ...(key ? { key } : {}),
      map: Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        inferFromValue(k, v, label),
      ),
    };
  }
  throw new Error(
    `${label}: cannot convert ${value === null ? "null" : typeof value} into a GTM parameter` +
      `${key ? ` for key "${key}"` : ""}. Use a string, number, boolean, array or object.`,
  );
}

// ===========================================================================
// Validation of an explicit Parameter[]
// ===========================================================================

function validateParameter(raw: unknown, label: string, insideList: boolean): GtmParameter {
  const obj = normObj(raw, label);
  if (!obj) throw new Error(`${label}: every parameter must be an object.`);

  // Accept snake_case keys, as the tool schemas do elsewhere.
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) p[snakeToCamel(k)] = v;

  // A partial entry with no type at all: infer it rather than failing.
  if (p.type === undefined) {
    if ("value" in p || "list" in p || "map" in p) {
      const carrier = "list" in p ? p.list : "map" in p ? p.map : p.value;
      return validateParameter(
        { ...inferFromValue(p.key as string | undefined, carrier, label) },
        label,
        insideList,
      );
    }
    throw new Error(
      `${label}: a parameter needs a "type". Valid types are ${PARAMETER_TYPES.join(", ")}. ` +
        `Received ${JSON.stringify(obj).slice(0, 160)}`,
    );
  }

  const type = String(p.type);
  if (!(PARAMETER_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `${label}: unknown parameter type ${JSON.stringify(type)}. Valid types are ` +
        `${PARAMETER_TYPES.join(", ")}. Note that a GA4 event tag references its Google Tag ` +
        `with type "tagReference" and the tag's NAME.`,
    );
  }

  const key = p.key === undefined ? undefined : String(p.key);
  // Top-level and map entries need a key; entries directly inside a list must not have one.
  if (insideList && key !== undefined) {
    // GTM tolerates this inconsistently; stripping is the safe move.
    delete p.key;
  }

  if (type === "list") {
    if ("value" in p) {
      throw new Error(
        `${label}: parameter ${key ? `"${key}" ` : ""}has type "list" but carries "value". A ` +
          `list parameter uses the "list" key, holding an array of parameters.`,
      );
    }
    const entries = normArray(p.list, `${label}.list`) ?? [];
    return {
      type,
      ...(insideList ? {} : key !== undefined ? { key } : {}),
      list: entries.map((e) => validateParameter(e, `${label}.list[]`, true)),
    };
  }

  if (type === "map") {
    if ("value" in p) {
      throw new Error(
        `${label}: parameter ${key ? `"${key}" ` : ""}has type "map" but carries "value". A map ` +
          `parameter uses the "map" key, holding an array of parameters that each have a key.`,
      );
    }
    const entries = normArray(p.map, `${label}.map`) ?? [];
    return {
      type,
      ...(insideList ? {} : key !== undefined ? { key } : {}),
      map: entries.map((e) => validateParameter(e, `${label}.map[]`, false)),
    };
  }

  // Scalar types. The value is ALWAYS a string in GTM.
  if (!SCALAR_TYPES.has(type) && type !== "typeUnspecified") {
    throw new Error(`${label}: unhandled parameter type ${type}.`);
  }
  if (p.value === undefined) {
    throw new Error(
      `${label}: parameter ${key ? `"${key}" ` : ""}of type "${type}" needs a "value".`,
    );
  }
  if (Array.isArray(p.value) || (p.value !== null && typeof p.value === "object")) {
    throw new Error(
      `${label}: parameter ${key ? `"${key}" ` : ""}of type "${type}" has an object/array ` +
        `"value". Use type "list" or "map" for structured values.`,
    );
  }
  // Coerce the single most common model error: a JSON boolean or number.
  const value = String(p.value);

  return {
    type,
    ...(insideList ? {} : key !== undefined ? { key } : {}),
    value,
    ...(p.isWeakReference === true ? { isWeakReference: true } : {}),
  };
}

/**
 * Accepts, in order: undefined; a JSON string; a valid Parameter[]; a partial
 * Parameter[] missing types; or a flat {key: value} shorthand object.
 * Returns a validated Parameter[].
 */
export function toGtmParameters(input: unknown, label = "parameters"): GtmParameter[] | undefined {
  if (input === undefined || input === null) return undefined;
  const parsed = parseIfJsonString(input, label);

  if (Array.isArray(parsed)) {
    return parsed.map((p, i) => validateParameter(p, `${label}[${i}]`, false));
  }

  if (typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).map(([k, v]) =>
      inferFromValue(k, v, label),
    );
  }

  throw new Error(
    `${label} must be an array of GTM parameters, or a flat object of {key: value} pairs. ` +
      `Received ${typeof parsed}.`,
  );
}

// ===========================================================================
// Parameter[]  ->  flat object
// ===========================================================================

function flattenOne(p: GtmParameter): unknown {
  if (p.type === "list") return (p.list ?? []).map(flattenOne);
  if (p.type === "map") {
    const out: Record<string, unknown> = {};
    for (const child of p.map ?? []) {
      if (child.key !== undefined) out[child.key] = flattenOne(child);
    }
    return out;
  }
  if (p.type === "boolean") return p.value === "true";
  if (p.type === "integer") {
    const n = Number(p.value);
    return Number.isFinite(n) ? n : p.value;
  }
  return p.value;
}

/**
 * The inverse of the shorthand path, used by read tools. An entity comes back
 * with both its raw `parameter` array and a flattened `_parameters`, so the
 * model can read flat and write flat and the two agree.
 */
export function fromGtmParameters(params: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(params)) return undefined;
  const out: Record<string, unknown> = {};
  for (const p of params as GtmParameter[]) {
    if (p && typeof p === "object" && p.key !== undefined) out[p.key] = flattenOne(p);
  }
  return out;
}

// ===========================================================================
// Variable-reference extraction, for the soft warning on writes
// ===========================================================================

const VAR_REF_RE = /\{\{([^}]+)\}\}/g;

/** Every {{Variable Name}} mentioned anywhere in a parameter tree. */
export function extractVariableReferences(params: readonly GtmParameter[] | undefined): string[] {
  const found = new Set<string>();
  const walk = (list: readonly GtmParameter[] | undefined): void => {
    for (const p of list ?? []) {
      if (typeof p.value === "string") {
        for (const m of p.value.matchAll(VAR_REF_RE)) {
          const name = m[1]?.trim();
          if (name) found.add(name);
        }
      }
      walk(p.list);
      walk(p.map);
    }
  };
  walk(params);
  return [...found];
}
