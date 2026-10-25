export const TRACKER_SCHEMA_VERSION = 3;
export const MAX_STATE_CHARS = 64000;
export const TRACKER_TEXT_LIMITS = Object.freeze({ text: 1600, name: 160, id: 180 });
export const UNKNOWN = "Unknown";
const stringSchema = () => ({ type: "string" });
const enumSchema = values => ({ type: "string", enum: values });
const objectSchema = properties => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const textObject = keys => objectSchema(Object.fromEntries(keys.map(key => [key, stringSchema()])));
const actionSchema = () => enumSchema(["preserve", "update"]);
const listSchema = (items, maxItems) => ({ type: "array", items, maxItems });

export const PROFILE_FIELDS = ["age", "gender", "identity", "background", "personality", "preferences", "relationshipContext", "boundaries", "privateFacts"];
const profileSchema = textObject(PROFILE_FIELDS);
const appearanceSchema = textObject(["face", "eyes", "skin", "body", "distinguishingFeatures"]);
const visibleSchema = textObject(["hairAndGrooming", "dressAndLayers", "physicalState", "position", "activity", "items"]);
const internalSchema = textObject(["mood", "intent", "knowledge", "beliefs", "concerns"]);
const worldProperties = {
  date: stringSchema(), time: stringSchema(), weather: stringSchema(), location: stringSchema(),
  immediateContext: stringSchema(), proximityAndContact: stringSchema(), sceneStatus: enumSchema(["active", "ended"]), action: actionSchema(),
};
const characterProperties = {
  id: stringSchema(), name: stringSchema(), role: enumSchema(["main", "npc", "user"]),
  controller: enumSchema(["model", "user"]), profile: profileSchema, appearance: appearanceSchema,
  visible: visibleSchema, internal: internalSchema, action: actionSchema(),
};
const relationshipProperties = {
  id: stringSchema(), fromId: stringSchema(), toId: stringSchema(),
  publicStatus: stringSchema(), privateState: stringSchema(), boundaryOrConcern: stringSchema(), action: actionSchema(),
};
const placeProperties = {
  id: stringSchema(), name: stringSchema(), description: stringSchema(), currentState: stringSchema(),
  connections: stringSchema(), privateFacts: stringSchema(), action: actionSchema(),
};
const objectiveProperties = {
  id: stringSchema(), ownerId: stringSchema(), objective: stringSchema(),
  status: enumSchema(["active", "completed", "abandoned"]), timing: stringSchema(), action: actionSchema(),
};

// Structural, regex-free provider schema; exact limits and provenance are enforced locally.
export const TRACKER_OUTPUT_JSON_SCHEMA = objectSchema({
  schemaVersion: { type: "integer", enum: [TRACKER_SCHEMA_VERSION] }, world: objectSchema(worldProperties),
  characters: listSchema(objectSchema(characterProperties), 24),
  relationships: listSchema(objectSchema(relationshipProperties), 48),
  places: listSchema(objectSchema(placeProperties), 32),
  objectives: listSchema(objectSchema(objectiveProperties), 12),
});
const canonicalSection = properties => objectSchema({ ...Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "action")), sourceMessageId: stringSchema() });
export const CANONICAL_STATE_SCHEMA = objectSchema({
  schemaVersion: { type: "integer", enum: [TRACKER_SCHEMA_VERSION] }, world: canonicalSection(worldProperties),
  characters: listSchema(canonicalSection(characterProperties), 24),
  relationships: listSchema(canonicalSection(relationshipProperties), 48),
  places: listSchema(canonicalSection(placeProperties), 32),
  objectives: listSchema(canonicalSection(objectiveProperties), 12),
});

export function cloneEmptyState() {
  return { schemaVersion: TRACKER_SCHEMA_VERSION, world: { date: UNKNOWN, time: UNKNOWN, weather: UNKNOWN,
    location: UNKNOWN, immediateContext: UNKNOWN, proximityAndContact: UNKNOWN, sceneStatus: "active", sourceMessageId: "card-baseline" },
    characters: [], relationships: [], places: [], objectives: [] };
}

function validateNode(value, schema, path) {
  const invalid = (message, code = "invalid_value") => Object.assign(new Error(message), { path, code });
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${path} must be an object`, "invalid_type");
    const expected = Object.keys(schema.properties);
    if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw invalid(`${path} has missing or unexpected fields`, "invalid_fields");
    return Object.fromEntries(expected.map(key => [key, validateNode(value[key], schema.properties[key], `${path}.${key}`)]));
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw invalid(`${path} exceeds its list limit or is not an array`, "invalid_array");
    return value.map((entry, index) => validateNode(entry, schema.items, `${path}[${index}]`));
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value) || !schema.enum.includes(value)) throw invalid(`${path} has an unsupported version`, "invalid_version");
    return value;
  }
  if (typeof value !== "string") throw invalid(`${path} must be text`, "invalid_type");
  const clean = value.replace(/\r\n?/g, "\n").trim();
  const limit = /\.(id|fromId|toId|ownerId|sourceMessageId)$/.test(path) ? TRACKER_TEXT_LIMITS.id : /\.name$/.test(path) ? TRACKER_TEXT_LIMITS.name : TRACKER_TEXT_LIMITS.text;
  if (!clean) throw invalid(`${path} contains invalid text: empty after trimming; provide nonempty text or Unknown for an unsupported fact`, "invalid_text");
  if (clean.length > limit) throw invalid(`${path} contains invalid text: ${clean.length} characters exceeds the ${limit}-character limit; return at most ${limit} characters`, "invalid_text");
  if (/<!--|-->|<\/?story_continuity/i.test(clean)) throw invalid(`${path} contains invalid text: reserved HTML comment or story_continuity markup; return plain text without these markers`, "invalid_text");
  if (schema.enum && !schema.enum.includes(clean)) throw Object.assign(new Error(`${path} contains an invalid choice ${JSON.stringify(clean)}; expected ${schema.enum.map(choice => JSON.stringify(choice)).join(" or ")}`),
    { path, code: "invalid_choice", allowedValues: schema.enum });
  return clean;
}

export function validateTrackerRecord(value, kind, path) {
  return validateNode(value, kind === "world" ? TRACKER_OUTPUT_JSON_SCHEMA.properties.world : TRACKER_OUTPUT_JSON_SCHEMA.properties[kind].items, path);
}

// A display-only candidate assembled from independently validated records and
// fields. It never becomes a checkpoint, baseline, export or injected context.
export function partialTrackerPreview(decoded, issues, previousState, sourceMessageId) {
  const previous = previousState ?? cloneEmptyState(), unavailableFields = [], root = { schemaVersion: TRACKER_SCHEMA_VERSION, world: { action: "update" } };
  for (const [key, schema] of Object.entries(worldProperties)) {
    if (key === "action") continue;
    try { root.world[key] = validateNode(decoded.world?.[key], schema, `world.${key}`); }
    catch { root.world[key] = previous.world[key]; unavailableFields.push(`world.${key}`); }
    if (issues.some(issue => issue.code === "missing_initial_value" && issue.path === `world.${key}`) && !unavailableFields.includes(`world.${key}`)) unavailableFields.push(`world.${key}`);
  }
  for (const kind of ["characters", "relationships", "places", "objectives"]) root[kind] = (Array.isArray(decoded[kind]) ? decoded[kind] : [])
    .filter((entry, index) => !issues.some(issue => issue.code !== "missing_initial_value" && issue.kind === kind && (issue.index === index || issue.index === -1)));
  const characters = new Set([...previous.characters, ...root.characters].map(entry => entry.id));
  root.relationships = root.relationships.filter(entry => characters.has(entry.fromId) && characters.has(entry.toId) && entry.fromId !== entry.toId);
  root.objectives = root.objectives.filter(entry => characters.has(entry.ownerId));
  try {
    const state = materializeTrackerOutput(root, previousState, sourceMessageId);
    return { state, unavailableFields };
  } catch { return null; }
}

function checkReferences(state, allowedSources) {
  for (const key of ["characters", "relationships", "places", "objectives"]) {
    const ids = new Set();
    for (const entry of state[key]) {
      if (!/^[a-zA-Z0-9_.:-]{1,180}$/.test(entry.id) || ids.has(entry.id)) throw new Error(`${key} has an invalid or duplicate id`);
      ids.add(entry.id);
    }
  }
  const characters = new Set(state.characters.map(entry => entry.id));
  for (const rel of state.relationships) if (!characters.has(rel.fromId) || !characters.has(rel.toId) || rel.fromId === rel.toId) throw new Error("Relationship references must identify two established characters");
  for (const obj of state.objectives) if (!characters.has(obj.ownerId)) throw new Error("Objective owner must be an established character");
  for (const char of state.characters) {
    if ((char.role === "user") !== (char.controller === "user")) throw new Error("User characters require the user role and controller");
    if (char.controller === "user" && Object.values(char.internal).some(value => value !== UNKNOWN)) throw new Error("User internal state must remain Unknown");
  }
  if (allowedSources) for (const section of [state.world, ...state.characters, ...state.relationships, ...state.places, ...state.objectives]) {
    if (!allowedSources.has(section.sourceMessageId)) throw new Error("State provenance does not belong to this branch");
  }
  if (JSON.stringify(state).length > MAX_STATE_CHARS) throw new Error("State exceeds the serialized size limit");
}

export function validateState(value, { allowedSourceMessageIds } = {}) {
  const state = validateNode(upgradeTrackerState(value), CANONICAL_STATE_SCHEMA, "state");
  checkReferences(state, allowedSourceMessageIds ? new Set(allowedSourceMessageIds) : null);
  return state;
}

export function upgradeTrackerState(value) {
  if (![1, 2].includes(value?.schemaVersion)) return value;
  const upgraded = structuredClone(value);
  upgraded.schemaVersion = TRACKER_SCHEMA_VERSION;
  for (const char of upgraded.characters ?? []) if (char.profile && typeof char.profile === "object") {
    if (value.schemaVersion === 1) {
      if (!Object.hasOwn(char.profile, "relationshipContext")) char.profile.relationshipContext = UNKNOWN;
      if (!Object.hasOwn(char.profile, "boundaries")) char.profile.boundaries = UNKNOWN;
    }
    if (!Object.hasOwn(char.profile, "age")) char.profile.age = UNKNOWN;
    if (!Object.hasOwn(char.profile, "gender")) char.profile.gender = UNKNOWN;
  }
  return upgraded;
}

export class TrackerScopeError extends Error {
  constructor(violations) {
    super(violations.map(({ kind, id, name }) => `Cannot update an omitted ${kind} entity ${id}${name ? ` (${JSON.stringify(name)})` : ""}`).join("; ") + "; preserve it or omit it.");
    this.violations = violations;
  }
}

export function materializeTrackerOutput(value, previousState, sourceMessageId, { allowedUpdateIds } = {}) {
  // Preserved payload fields have no authority. Restore from saved state before
  // validating fields that the model may have unnecessarily copied or invented.
  previousState = previousState ? validateState(previousState) : null;
  const restored = structuredClone(value);
  if (previousState && restored && typeof restored === "object") {
    if (restored.world?.action === "preserve") restored.world = { ...previousState.world, action: "preserve" };
    if (restored.world) delete restored.world.sourceMessageId;
    for (const kind of ["characters", "relationships", "places", "objectives"]) if (Array.isArray(restored[kind])) restored[kind] = restored[kind].map(candidate => {
      const prior = previousState[kind].find(entry => entry.id === candidate?.id);
      if (candidate?.action !== "preserve" || !prior) return candidate;
      if (kind === "characters" && ["role", "controller"].some(key => candidate[key] !== undefined && candidate[key] !== prior[key])) throw new Error("An established character's role and controller cannot be changed");
      const { sourceMessageId: ignored, ...data } = prior;
      return { ...data, action: "preserve" };
    });
  }
  const output = validateNode(restored, TRACKER_OUTPUT_JSON_SCHEMA, "output");
  for (const key of ["characters", "relationships", "places", "objectives"]) {
    if (new Set(output[key].map(entry => entry.id)).size !== output[key].length) throw new Error(`${key} contains duplicate ids`);
  }
  const previous = previousState ?? cloneEmptyState();
  const unchanged = (candidate, prior) => prior && Object.keys(prior).every(key => key === "sourceMessageId" || JSON.stringify(candidate[key]) === JSON.stringify(prior[key]));
  const violations = [];
  if (allowedUpdateIds) for (const kind of ["characters", "relationships", "places", "objectives"]) {
    const saved = new Map(previous[kind].map(entry => [entry.id, entry]));
    for (const candidate of output[kind]) {
      const prior = saved.get(candidate.id);
      if (prior && !allowedUpdateIds[kind].has(candidate.id) && candidate.action !== "preserve" && !unchanged(candidate, prior)) {
        violations.push({ kind, id: prior.id, ...(prior.name ? { name: prior.name } : {}) });
      }
    }
  }
  if (violations.length) throw new TrackerScopeError(violations);
  const materialize = (candidate, prior) => {
    if (candidate.action === "preserve") {
      if (!prior) throw new Error("A new entity cannot use preserve");
      return structuredClone(prior);
    }
    const { action, ...data } = candidate;
    if (unchanged(candidate, prior)) return structuredClone(prior);
    return { ...data, sourceMessageId };
  };
  const state = { schemaVersion: TRACKER_SCHEMA_VERSION, world: materialize(output.world, previous.world) };
  for (const key of ["characters", "relationships", "places", "objectives"]) {
    const merged = new Map(previous[key].map(entry => [entry.id, structuredClone(entry)]));
    for (const candidate of output[key]) {
      const prior = merged.get(candidate.id);
      if (key === "characters" && prior && (prior.controller !== candidate.controller || prior.role !== candidate.role)) throw new Error("An established character's role and controller cannot be changed");
      merged.set(candidate.id, materialize(candidate, prior));
    }
    state[key] = [...merged.values()];
  }
  return validateState(state, { allowedSourceMessageIds: [...stateSourceIds(previous), sourceMessageId] });
}

export function stateSourceIds(state) {
  if (!state) return [];
  return [...new Set([state.world, ...state.characters, ...state.relationships, ...state.places, ...state.objectives].map(entry => entry.sourceMessageId))];
}

export function trackerStateForLlm(state) {
  if (!state) return null;
  state = upgradeTrackerState(state);
  const strip = section => ({ ...structuredClone(Object.fromEntries(Object.entries(section).filter(([key]) => key !== "sourceMessageId"))), action: "preserve" });
  return { schemaVersion: TRACKER_SCHEMA_VERSION, world: strip(state.world), ...Object.fromEntries(["characters", "relationships", "places", "objectives"].map(key => [key, state[key].map(strip)])) };
}

export function publicTrackerSnapshot(state, { legacy = false } = {}) {
  if (!state) return null;
  const { sourceMessageId, ...world } = state.world;
  return { world, characters: state.characters.map(char => ({ id: char.id, name: char.name, role: char.role, ...(legacy ? {} : { age: char.profile.age, gender: char.profile.gender }), appearance: char.appearance, visible: char.visible })),
    relationships: state.relationships.map(rel => ({ fromId: rel.fromId, toId: rel.toId, publicStatus: rel.publicStatus })),
    places: state.places.map(place => ({ id: place.id, name: place.name, description: place.description, currentState: place.currentState, connections: place.connections })) };
}

export function remapStateSources(state, messageMap, fallback) {
  const remapped = structuredClone(state);
  for (const section of [remapped.world, ...remapped.characters, ...remapped.relationships, ...remapped.places, ...remapped.objectives]) {
    const id = section.sourceMessageId;
    if (fallback) section.sourceMessageId = fallback;
    else if (id !== "card-baseline") {
      if (!messageMap.has(id)) throw new Error("Incomplete fork provenance map");
      section.sourceMessageId = messageMap.get(id);
    }
  }
  return validateState(remapped);
}

export function compactPromptState(state) {
  const projected = trackerStateForLlm(state);
  const prune = value => {
    if (Array.isArray(value)) return value.map(prune);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key, entry]) => key !== "action" && entry !== UNKNOWN && !(Array.isArray(entry) && !entry.length)).map(([key, entry]) => [key, prune(entry)]));
    return value;
  };
  return prune(projected);
}

export function legacyTrackerState(state, version = 1) {
  if (!state) return null;
  const legacy = structuredClone(state);
  legacy.schemaVersion = version;
  for (const char of legacy.characters) {
    delete char.profile.age; delete char.profile.gender;
    if (version === 1) { delete char.profile.relationshipContext; delete char.profile.boundaries; }
  }
  return legacy;
}
