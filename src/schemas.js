export const TRACKER_SCHEMA_VERSION = 1;
export const MAX_STATE_CHARS = 64000;
export const UNKNOWN = "Unknown";
const stringSchema = () => ({ type: "string" });
const enumSchema = values => ({ type: "string", enum: values });
const objectSchema = properties => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const textObject = keys => objectSchema(Object.fromEntries(keys.map(key => [key, stringSchema()])));
const actionSchema = () => enumSchema(["preserve", "update"]);
const listSchema = (items, maxItems) => ({ type: "array", items, maxItems });

const profileSchema = textObject(["identity", "background", "personality", "preferences", "privateFacts"]);
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
  schemaVersion: { type: "integer", enum: [1] }, world: objectSchema(worldProperties),
  characters: listSchema(objectSchema(characterProperties), 24),
  relationships: listSchema(objectSchema(relationshipProperties), 48),
  places: listSchema(objectSchema(placeProperties), 32),
  objectives: listSchema(objectSchema(objectiveProperties), 12),
});
const canonicalSection = properties => objectSchema({ ...Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "action")), sourceMessageId: stringSchema() });
export const CANONICAL_STATE_SCHEMA = objectSchema({
  schemaVersion: { type: "integer", enum: [1] }, world: canonicalSection(worldProperties),
  characters: listSchema(canonicalSection(characterProperties), 24),
  relationships: listSchema(canonicalSection(relationshipProperties), 48),
  places: listSchema(canonicalSection(placeProperties), 32),
  objectives: listSchema(canonicalSection(objectiveProperties), 12),
});

export function cloneEmptyState() {
  return { schemaVersion: 1, world: { date: UNKNOWN, time: UNKNOWN, weather: UNKNOWN,
    location: UNKNOWN, immediateContext: UNKNOWN, proximityAndContact: UNKNOWN, sceneStatus: "active", sourceMessageId: "card-baseline" },
    characters: [], relationships: [], places: [], objectives: [] };
}

function validateNode(value, schema, path) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const expected = Object.keys(schema.properties);
    if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error(`${path} has missing or unexpected fields`);
    return Object.fromEntries(expected.map(key => [key, validateNode(value[key], schema.properties[key], `${path}.${key}`)]));
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw new Error(`${path} exceeds its list limit or is not an array`);
    return value.map((entry, index) => validateNode(entry, schema.items, `${path}[${index}]`));
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value) || !schema.enum.includes(value)) throw new Error(`${path} has an unsupported version`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${path} must be text`);
  const clean = value.replace(/\r\n?/g, "\n").trim();
  const limit = /\.(id|fromId|toId|ownerId|sourceMessageId)$/.test(path) ? 180 : /\.name$/.test(path) ? 160 : 1600;
  if (!clean || clean.length > limit || /<!--|-->|<\/?story_continuity/i.test(clean)) throw new Error(`${path} contains invalid text`);
  if (schema.enum && !schema.enum.includes(clean)) throw new Error(`${path} contains an invalid choice`);
  return clean;
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
  const state = validateNode(value, CANONICAL_STATE_SCHEMA, "state");
  checkReferences(state, allowedSourceMessageIds ? new Set(allowedSourceMessageIds) : null);
  return state;
}

export function materializeTrackerOutput(value, previousState, sourceMessageId) {
  const output = validateNode(value, TRACKER_OUTPUT_JSON_SCHEMA, "output");
  for (const key of ["characters", "relationships", "places", "objectives"]) {
    if (new Set(output[key].map(entry => entry.id)).size !== output[key].length) throw new Error(`${key} contains duplicate ids`);
  }
  const previous = previousState ? validateState(previousState) : cloneEmptyState();
  const materialize = (candidate, prior) => {
    if (candidate.action === "preserve") {
      if (!prior) throw new Error("A new entity cannot use preserve");
      return structuredClone(prior);
    }
    const { action, ...data } = candidate;
    if (prior && JSON.stringify(data) === JSON.stringify(Object.fromEntries(Object.entries(prior).filter(([key]) => key !== "sourceMessageId")))) return structuredClone(prior);
    return { ...data, sourceMessageId };
  };
  const state = { schemaVersion: 1, world: materialize(output.world, previous.world) };
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
  const strip = section => ({ ...structuredClone(Object.fromEntries(Object.entries(section).filter(([key]) => key !== "sourceMessageId"))), action: "preserve" });
  return { schemaVersion: 1, world: strip(state.world), ...Object.fromEntries(["characters", "relationships", "places", "objectives"].map(key => [key, state[key].map(strip)])) };
}

export function publicTrackerSnapshot(state) {
  if (!state) return null;
  const { sourceMessageId, ...world } = state.world;
  return { world, characters: state.characters.map(char => ({ id: char.id, name: char.name, role: char.role, appearance: char.appearance, visible: char.visible })),
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
