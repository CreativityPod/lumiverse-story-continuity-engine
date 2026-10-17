import { TRACKER_SCHEMA_VERSION, TrackerScopeError, materializeTrackerOutput } from "./schemas.js";
import { TRACKER_COLLECTIONS, trackerFieldPaths } from "./protocol.js";
import { decodeModelOutput } from "./aliases.js";

const kinds = ["world", ...TRACKER_COLLECTIONS];
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 180) => typeof value === "string" ? value.slice(0, limit) : "";
const aliasOf = record => typeof record?.id === "string" ? record.id.trim() : "";

// Private checkpoint metadata only: no rejected prose is exposed or injected.
export function normalizePartialUpdate(value) {
  if (!plain(value) || !Array.isArray(value.issues)) return null;
  const issues = value.issues.filter(issue => plain(issue) && kinds.includes(issue.kind)).slice(0, 96).map(issue => ({
    kind: issue.kind, id: text(issue.id), alias: text(issue.alias), path: text(issue.path), code: text(issue.code),
    fields: issue.fields === null ? null : [...new Set((Array.isArray(issue.fields) ? issue.fields : [])
      .filter(field => trackerFieldPaths(issue.kind).includes(field)))],
  }));
  return issues.length ? { sourceMessageId: text(value.sourceMessageId), issues } : null;
}

function removeFields(record, fields) {
  if (Array.isArray(record.changes)) record.changes = record.changes.filter(change => !fields.includes(change?.field));
  else for (const field of fields) {
    const keys = field.split("."), last = keys.pop(); let target = record;
    for (const key of keys) target = target?.[key];
    if (plain(target)) delete target[last];
  }
}

function offeredFields(record, kind) {
  if (!plain(record) || record.action === "preserve") return [];
  if (Array.isArray(record.changes)) return record.changes.map(change => change?.field).filter(field => trackerFieldPaths(kind).includes(field));
  return trackerFieldPaths(kind).filter(field => {
    let value = record; for (const key of field.split(".")) value = value?.[key]; return value !== undefined;
  });
}

// The entire retained candidate is decoded and validated again after each removal.
// Missing fields inherit prior values (or Unknown for a new, valid declaration).
export function recoverPartialTrackerOutput(output, registry, options = {}) {
  if (!plain(output) || output.schemaVersion !== TRACKER_SCHEMA_VERSION
    || Object.keys(output).some(key => !["schemaVersion", ...kinds].includes(key))) return null;
  const candidate = structuredClone(output), issues = [];
  const note = (kind, alias, fields, code, path) => {
    let id = registry.reverse.get(alias)?.id ?? "";
    if (!id && registry.creation.get(alias)?.kind === kind) { try { id = registry.allocate(alias).id; } catch { /* An invalid declaration remains unresolved. */ } }
    if (!issues.some(issue => issue.kind === kind && issue.alias === alias && JSON.stringify(issue.fields) === JSON.stringify(fields))) {
      issues.push({ kind, id, alias, fields, code, path });
    }
  };
  const drop = (kind, alias, code, path) => {
    note(kind, alias, null, code, path);
    if (kind === "world") candidate.world = { action: "preserve", changes: [] };
    else candidate[kind] = candidate[kind].filter(record => aliasOf(record) !== alias);
  };
  const hold = (kind, record, fields, code, path) => {
    const actual = offeredFields(record, kind).filter(field => fields.includes(field));
    if (!actual.length) return false;
    note(kind, kind === "world" ? "world" : aliasOf(record), actual, code, path);
    removeFields(record, actual); return true;
  };
  const holdPhysical = () => {
    let changed = false;
    if (plain(candidate.world)) changed = hold("world", candidate.world, ["location", "proximityAndContact"], "dependent_change", "world.location/proximityAndContact") || changed;
    for (const record of candidate.characters ?? []) if (plain(record)) changed = hold("characters", record,
      trackerFieldPaths("characters").filter(field => field.startsWith("visible.")), "dependent_change", `characters.${record.id}.visible`) || changed;
    for (const record of candidate.places ?? []) if (plain(record)) changed = hold("places", record, ["currentState"], "dependent_change", `places.${record.id}.currentState`) || changed;
    return changed;
  };
  for (const kind of TRACKER_COLLECTIONS) if (!Array.isArray(candidate[kind])) {
    note(kind, "", null, "invalid_collection", kind); candidate[kind] = [];
  }
  if (!plain(candidate.world)) { note("world", "world", null, "invalid_record", "world"); candidate.world = { action: "preserve", changes: [] }; }
  for (let step = 0; step < 128; step++) {
    try {
      const decoded = decodeModelOutput(candidate, registry, options);
      const state = materializeTrackerOutput(decoded, registry.previousState, options.sourceMessageId, options);
      const partial = normalizePartialUpdate({ sourceMessageId: options.sourceMessageId, issues: [...issues.map(issue => ({ ...issue, id: issue.kind !== "world" && !state[issue.kind].some(record => record.id === issue.id) ? "" : issue.id })), ...(options.pendingIssues ?? [])] });
      return partial ? { state, partial } : null;
    } catch (error) {
      if (error instanceof TrackerScopeError) {
        for (const violation of error.violations) {
          if (["characters", "places"].includes(violation.kind)) holdPhysical();
          drop(violation.kind, registry.forward[violation.kind].get(violation.id), "out_of_scope", `${violation.kind}.${violation.id}`);
        }
        continue;
      }
      if (!Array.isArray(error.issues) || !error.issues.length) return null;
      let changed = false;
      const pending = error.issues.map(issue => ({ ...issue, record: issue.kind === "world" ? candidate.world : candidate[issue.kind]?.[issue.index] }));
      for (const issue of pending) {
        const kind = issue.kind;
        if (!kinds.includes(kind)) return null;
        if (kind !== "world" && issue.index === -1) {
          note(kind, "", null, issue.code, issue.path); candidate[kind] = []; changed = true; continue;
        }
        const record = issue.record;
        if (kind !== "world" && plain(record) && !candidate[kind].includes(record)) continue;
        if (!plain(record)) {
          if (kind === "world") return null;
          note(kind, "", null, issue.code, issue.path); candidate[kind] = candidate[kind].filter(entry => entry !== record); changed = true; continue;
        }
        const alias = kind === "world" ? "world" : aliasOf(record);
        const field = issue.path.replace(/^(?:world\.|[a-z]+\[\d+\]\.)/, "");
        if (options.requireInitialScene && (issue.code === "missing_initial_value" || kind === "world" && ["date", "time", "weather", "sceneStatus"].includes(field))) return null;
        if (kind === "world" && ["date", "time"].includes(field)) {
          changed = hold(kind, record, ["date", "time"], issue.code, issue.path) || changed;
        } else if (kind === "relationships" && ["fromId", "toId"].includes(field) || kind === "objectives"
          || !trackerFieldPaths(kind).includes(field)) {
          // Invalid identities/references are never reinterpreted as a different
          // owner or partner. Their whole proposed record remains pending.
          if (kind === "characters") changed = holdPhysical() || changed;
          drop(kind, alias, issue.code, issue.path); changed = true;
        } else {
          if (kind === "characters" && field.startsWith("visible.") || kind === "world" && ["location", "proximityAndContact"].includes(field)
            || kind === "places" && field === "currentState") changed = holdPhysical() || changed;
          changed = hold(kind, record, [field], issue.code, issue.path) || changed;
        }
      }
      if (!changed) return null;
    }
  }
  return null;
}

// Retrying an old partial checkpoint may correct only its unresolved components.
// The already accepted clock, outfits, profiles, etc. cannot be applied twice.
export function scopePartialRetry(output, partial, registry) {
  if (!plain(output) || output.schemaVersion !== TRACKER_SCHEMA_VERSION
    || Object.keys(output).some(key => !["schemaVersion", ...kinds].includes(key))) return { output, pendingIssues: [] };
  const issues = normalizePartialUpdate(partial)?.issues ?? [], pendingIssues = [], accepted = new Map();
  const targetsFor = (kind, alias) => issues.filter(issue => issue.kind === kind && (kind === "world"
    || !issue.alias && issue.fields === null || issue.id && registry.forward[kind].get(issue.id) === alias || !issue.id && registry.creation.get(alias)?.kind === kind));
  const scoped = { schemaVersion: TRACKER_SCHEMA_VERSION, world: { action: "preserve", changes: [] }, characters: [], relationships: [], places: [], objectives: [] };
  const take = (kind, record) => {
    if (!plain(record)) return;
    const targets = targetsFor(kind, aliasOf(record)), fields = offeredFields(record, kind);
    if (!targets.length) return;
    const whole = targets.some(target => target.fields === null), allowed = new Set(targets.flatMap(target => target.fields ?? []));
    const kept = structuredClone(record);
    if (!whole) removeFields(kept, fields.filter(field => !allowed.has(field)));
    for (const target of targets) {
      const required = whole && kind === "relationships" ? ["fromId", "toId"] : whole && kind === "objectives" ? ["ownerId", "objective", "status", "timing"] : target.fields;
      const provided = required ? required.every(field => fields.includes(field)) : fields.length > 0;
      if (provided) accepted.set(target, true);
    }
    if (kind === "world") scoped.world = kept; else scoped[kind].push(kept);
  };
  if (plain(output.world)) take("world", output.world);
  for (const kind of TRACKER_COLLECTIONS) if (Array.isArray(output[kind])) for (const record of output[kind]) take(kind, record);
  // A repaired endpoint may require a new user/NPC declaration in this response.
  const references = new Set([...scoped.relationships, ...scoped.objectives].flatMap(record => {
    const values = Array.isArray(record.changes) ? record.changes.filter(change => ["fromId", "toId", "ownerId"].includes(change.field)).map(change => change.value)
      : [record.fromId, record.toId, record.ownerId]; return values.filter(value => registry.creation.get(value)?.kind === "characters");
  }));
  for (const record of Array.isArray(output.characters) ? output.characters : []) if (references.has(record?.id) && !scoped.characters.some(entry => entry.id === record.id)) scoped.characters.push(structuredClone(record));
  // Coupled physical updates and clock rollovers must also stay together on retry.
  const coupled = [issues.filter(issue => issue.code === "dependent_change"),
    issues.filter(issue => issue.kind === "world" && issue.fields?.some(field => ["date", "time"].includes(field)))];
  for (const group of coupled) if (group.some(issue => !accepted.has(issue))) for (const issue of group) {
    accepted.delete(issue);
    const records = issue.kind === "world" ? [scoped.world] : scoped[issue.kind];
    for (const record of records) if (targetsFor(issue.kind, aliasOf(record)).includes(issue)) removeFields(record, issue.fields ?? trackerFieldPaths(issue.kind));
  }
  for (const issue of issues) if (!accepted.has(issue)) pendingIssues.push(issue);
  return { output: scoped, pendingIssues };
}
