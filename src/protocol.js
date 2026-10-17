import { TRACKER_OUTPUT_JSON_SCHEMA } from "./schemas.js";

export const TRACKER_CONTRACT_VERSION = 3;
export const TRACKER_COLLECTIONS = ["characters", "relationships", "places", "objectives"];

export class TrackerValidationError extends Error {
  constructor(issues) {
    super(issues.slice(0, 20).map(issue => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "TrackerValidationError";
    this.issues = issues;
  }
}

function recordSchema(kind) {
  return kind === "world" ? TRACKER_OUTPUT_JSON_SCHEMA.properties.world : TRACKER_OUTPUT_JSON_SCHEMA.properties[kind].items;
}

function trackerFields(kind) {
  const fields = new Map();
  const visit = (schema, prefix = "") => {
    for (const [key, field] of Object.entries(schema.properties)) {
      if (["id", "action"].includes(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (field.type === "object") visit(field, path); else fields.set(path, field);
    }
  };
  visit(recordSchema(kind));
  return fields;
}

export function trackerFieldPaths(kind) {
  return [...trackerFields(kind).keys()];
}

// A fixed, provider-friendly shape: absent changes preserve saved facts. No
// optional-property/nullable-schema extensions or copied profile bodies needed.
export function trackerPatchRecordSchema(kind, idSchema) {
  const fields = trackerFields(kind), textFields = [...fields].filter(([, field]) => !field.enum).map(([path]) => path);
  const changeSchema = (names, value) => ({ type: "object", additionalProperties: false,
    properties: { field: { type: "string", enum: names }, value }, required: ["field", "value"] });
  const branches = [changeSchema(textFields, { type: "string" }), ...[...fields].filter(([, field]) => field.enum)
    .map(([path, field]) => changeSchema([path], field))];
  const properties = {
    ...(idSchema ? { id: idSchema } : {}), action: { type: "string", enum: ["preserve", "update"] },
    changes: { type: "array", maxItems: fields.size, items: branches.length === 1 ? branches[0] : { anyOf: branches } },
  };
  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
}

export function expandTrackerRecord(candidate, kind, prior, identity = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("record must be an object");
  if (candidate.action === "preserve") {
    if (!prior) throw new Error("A new entity cannot use preserve");
    return { ...structuredClone(prior), action: "preserve" };
  }
  const schema = recordSchema(kind);
  const defaults = node => Object.fromEntries(Object.entries(node.properties).map(([key, field]) => [key,
    field.type === "object" ? defaults(field) : key === "action" ? "update" : key === "sceneStatus" ? "active" : "Unknown"]));
  const result = prior ? structuredClone(prior) : { ...defaults(schema), ...identity };
  result.action = candidate.action ?? "update";
  const normalizeChoice = (value, field, path, saved) => {
    if (!field.enum || typeof value !== "string") return value;
    const clean = value.trim().toLowerCase(), match = field.enum.find(choice => choice.toLowerCase() === clean);
    if (match) return match;
    // Unknown is absence of a new scene-state claim. Initialization starts active;
    // later turns retain the established state rather than inventing a transition.
    if (kind === "world" && path === "sceneStatus" && clean === "unknown") return saved;
    return value;
  };
  if (Object.hasOwn(candidate, "changes")) {
    const expected = kind === "world" ? ["action", "changes"] : ["id", "action", "changes"];
    if (Object.keys(candidate).some(key => !expected.includes(key))) throw new Error("patch record has unexpected fields");
    if (!Array.isArray(candidate.changes)) throw new Error("changes must be an array");
    const allowed = new Set(trackerFieldPaths(kind)), seen = new Set();
    for (const change of candidate.changes) {
      if (!change || Object.keys(change).length !== 2 || !Object.hasOwn(change, "field") || typeof change.value !== "string") throw new Error("each change requires a field and a text value");
      if (!allowed.has(change.field)) throw new Error(`unsupported change field ${JSON.stringify(change.field)}`);
      if (seen.has(change.field)) throw new Error(`duplicate change field ${JSON.stringify(change.field)}`);
      seen.add(change.field);
      const keys = change.field.split("."), key = keys.pop();
      let target = result;
      for (const parent of keys) target = target[parent];
      target[key] = normalizeChoice(change.value, trackerFields(kind).get(change.field), change.field, target[key]);
    }
  } else {
    // Accept old full responses and plain-mode sparse responses as well. Unknown
    // fields are errors; missing fields inherit only from the established record.
    const merge = (target, input, node, prefix = "") => {
      for (const [key, value] of Object.entries(input)) {
        if (!Object.hasOwn(node.properties, key)) throw new Error(`unexpected field ${JSON.stringify(key)}`);
        const path = prefix ? `${prefix}.${key}` : key;
        if (node.properties[key].type === "object" && value && typeof value === "object" && !Array.isArray(value)) merge(target[key], value, node.properties[key], path);
        else target[key] = normalizeChoice(structuredClone(value), node.properties[key], path, target[key]);
      }
    };
    merge(result, candidate, schema);
  }
  if (kind !== "world") result.id = candidate.id;
  return result;
}
