import { TRACKER_SCHEMA_VERSION, TRACKER_TEXT_LIMITS, TrackerScopeError, materializeTrackerOutput } from "./schemas.js";
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
    ...(issue.code === "truncated_text" ? { originalLength: Number.isFinite(issue.originalLength) ? Math.max(0, Math.round(issue.originalLength)) : 0 } : {}),
  }));
  return issues.length ? { sourceMessageId: text(value.sourceMessageId), issues } : null;
}

// These receipts contain only identities/field paths, never model prose. Older
// checkpoints have no receipts; their actual value changes remain usable evidence.
export function normalizeAcceptedUpdates(value) {
  if (!Array.isArray(value)) return undefined;
  const merged = new Map();
  for (const entry of value.slice(0, 256)) {
    if (!plain(entry) || !kinds.includes(entry.kind) || !Array.isArray(entry.fields)) continue;
    const id = entry.kind === "world" ? "world" : text(entry.id);
    if (!id) continue;
    const key = `${entry.kind}:${id}`, prior = merged.get(key);
    const fields = [...new Set([...(prior?.fields ?? []), ...entry.fields.filter(field => trackerFieldPaths(entry.kind).includes(field))])];
    if (fields.length) merged.set(key, { kind: entry.kind, id, fields });
  }
  return [...merged.values()];
}

export function acceptedTrackerUpdates(output, registry, state, { allowedUpdateIds, excludedIssues = [] } = {}) {
  const updates = [];
  for (const kind of kinds) for (const record of kind === "world" ? [output.world] : output[kind] ?? []) {
    if (!plain(record) || record.action === "preserve") continue;
    const alias = aliasOf(record);
    const id = kind === "world" ? "world" : registry.reverse.get(alias)?.id ?? (registry.creation.has(alias) ? registry.allocate(alias).id : "");
    if (kind !== "world" && (!state[kind].some(entry => entry.id === id)
      || allowedUpdateIds && registry.reverse.has(alias) && !allowedUpdateIds[kind]?.has(id))) continue;
    const excluded = excludedIssues.filter(issue => issue.kind === kind && (kind === "world" || issue.id === id || issue.alias === alias));
    const fields = offeredFields(record, kind).filter(field => !excluded.some(issue => issue.fields === null || issue.fields.includes(field)));
    if (fields.length) updates.push({ kind, id, fields });
  }
  return normalizeAcceptedUpdates(updates);
}

const fieldValue = (record, field) => field.split(".").reduce((value, key) => value?.[key], record);
function changedStateFields(previous, state) {
  const updates = [];
  for (const kind of kinds) for (const record of kind === "world" ? [state?.world] : state?.[kind] ?? []) {
    if (!record) continue;
    const prior = kind === "world" ? previous?.world : previous?.[kind]?.find(entry => entry.id === record.id);
    const fields = trackerFieldPaths(kind).filter(field => fieldValue(prior, field) !== fieldValue(record, field));
    if (fields.length) updates.push({ kind, id: kind === "world" ? "world" : record.id, fields });
  }
  return updates;
}

// Derive CURRENT attention from the selected history without rewriting historical
// failures. A branch rewind therefore restores its own warnings automatically.
export function activePartialUpdates(store) {
  const pending = new Map();
  const add = value => {
    const partial = normalizePartialUpdate(value);
    if (!partial) return;
    for (const issue of partial.issues) for (const field of issue.fields ?? ["*"]) {
      const identity = issue.kind === "world" ? "world" : issue.id || `${partial.sourceMessageId}:${issue.alias}`;
      pending.set(`${issue.kind}:${identity}:${field}`, { sourceMessageId: partial.sourceMessageId,
        issue: { ...issue, fields: field === "*" ? null : [field] } });
    }
  };
  if (store?.baseline) add(store.baselinePartial);
  let previous = store?.baseline;
  for (const checkpoint of Object.values(store?.checkpoints ?? {})) {
    const accepted = normalizeAcceptedUpdates([...changedStateFields(previous, checkpoint.state), ...(normalizeAcceptedUpdates(checkpoint.acceptedUpdates) ?? [])]);
    for (const [key, entry] of pending) {
      const issue = entry.issue;
      const receipt = accepted.find(update => update.kind === issue.kind && (issue.kind === "world" || issue.id && update.id === issue.id));
      // Unidentified failures cannot be matched by an array index or stale alias.
      const required = issue.fields ?? trackerFieldPaths(issue.kind);
      if (receipt && required.every(field => receipt.fields.includes(field))) pending.delete(key);
    }
    add(checkpoint.partial); previous = checkpoint.state;
  }
  const grouped = new Map();
  for (const { sourceMessageId, issue } of pending.values()) {
    if (!grouped.has(sourceMessageId)) grouped.set(sourceMessageId, { sourceMessageId, issues: [] });
    grouped.get(sourceMessageId).issues.push(issue);
  }
  return [...grouped.values()];
}

function shortenSummary(record, field) {
  const change = Array.isArray(record.changes) ? record.changes.find(entry => entry?.field === field) : null;
  const raw = change ? change.value : fieldValue(record, field);
  if (typeof raw !== "string") return null;
  const value = raw.replace(/\r\n?/g, "\n").trim(), limit = TRACKER_TEXT_LIMITS.text;
  if (value.length <= limit || /<!--|-->|<\/?story_continuity/i.test(value)) return null;
  let shortened = value.slice(0, limit - 2);
  const sentences = [...shortened.matchAll(/[.!?。！？](?=\s|$)/g)];
  const boundary = sentences.at(-1)?.index;
  if (boundary >= limit * 0.6) shortened = shortened.slice(0, boundary + 1);
  else if (shortened.lastIndexOf(" ") >= limit * 0.8) shortened = shortened.slice(0, shortened.lastIndexOf(" "));
  shortened = shortened.replace(/[\uD800-\uDBFF]$/, "").trimEnd() + " …";
  if (change) change.value = shortened; else record[field] = shortened;
  return value.length;
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
    for (let index = issues.length - 1; index >= 0; index--) if (issues[index].kind === kind && issues[index].alias === alias && issues[index].code === "truncated_text") issues.splice(index, 1);
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
      return partial ? { state, partial, acceptedUpdates: acceptedTrackerUpdates(candidate, registry, state,
        { ...options, excludedIssues: partial.issues }) } : null;
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
        // Only narrative summaries may be shortened, after the existing repair.
        // Identity, clock, boundary, objective and physical fields keep their guards.
        if (issue.code === "invalid_text" && (kind === "relationships" && field === "privateState" || kind === "world" && field === "immediateContext")) {
          const originalLength = shortenSummary(record, field);
          if (originalLength) {
            note(kind, alias, [field], "truncated_text", issue.path);
            issues.find(entry => entry.kind === kind && entry.alias === alias && entry.code === "truncated_text").originalLength = originalLength;
            changed = true; continue;
          }
        }
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
