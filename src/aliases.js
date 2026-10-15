import { TRACKER_OUTPUT_JSON_SCHEMA } from "./schemas.js";

const ALIAS_LIMITS = { characters: 24, places: 32, relationships: 48, objectives: 12 };
const opaqueId = value => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) || value.length >= 16 && /\d/.test(value) && !/\s/.test(value);
const aliasRegexEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizedAliasName = value => String(value ?? "").normalize("NFKC").trim().toLowerCase();

// Rebuilt from canonical order for each request; mappings are never entrusted to the model.
export function createAliasRegistry(sources = {}, state = null, { allocateId = () => crypto.randomUUID() } = {}) {
  const forward = Object.fromEntries([...Object.keys(ALIAS_LIMITS), "lore"].map(key => [key, new Map()]));
  const reverse = new Map(), creation = new Map(), allocated = new Map(), replacements = new Map();
  const counters = { c: 0, n: 0, u: 0, p: 0, r: 0, o: 0, l: 0 };
  const register = (kind, id, prefix, details = {}) => {
    if (forward[kind].has(id)) return forward[kind].get(id);
    const alias = `${prefix}${++counters[prefix]}`;
    forward[kind].set(id, alias); reverse.set(alias, { kind, id, ...details });
    if (id.includes(":") || opaqueId(id)) replacements.set(id, alias);
    return alias;
  };
  const previousCharacters = state?.characters ?? [];
  for (const card of sources.cards ?? []) {
    const id = `char:${card.id}`, prior = previousCharacters.find(char => char.id === id);
    const alias = register("characters", id, "c", { role: "main", controller: "model", name: prior?.name ?? card.name, prior });
    if (opaqueId(card.id)) replacements.set(card.id, alias);
  }
  for (const char of previousCharacters) register("characters", char.id, char.role === "main" ? "c" : char.role === "user" ? "u" : "n", { role: char.role, controller: char.controller, name: char.name, prior: char });
  for (const place of state?.places ?? []) register("places", place.id, "p", { name: place.name, prior: place });
  for (const relationship of state?.relationships ?? []) register("relationships", relationship.id, "r", { prior: relationship });
  for (const objective of state?.objectives ?? []) register("objectives", objective.id, "o", { prior: objective });
  for (const lore of sources.lore ?? []) {
    const alias = register("lore", `lore:${lore.id}`, "l");
    if (opaqueId(lore.id)) replacements.set(lore.id, alias);
  }
  const offerCreation = (kind, prefix, details = {}, max = ALIAS_LIMITS[kind] - forward[kind].size) => {
    for (let index = 1; index <= max; index++) creation.set(`new_${prefix}${index}`, { kind, ...details });
  };
  offerCreation("characters", "n", { role: "npc", controller: "model" });
  if (!previousCharacters.some(char => char.controller === "user") && !forward.characters.has("user") && forward.characters.size < 24) offerCreation("characters", "u", { role: "user", controller: "user" }, 1);
  offerCreation("places", "p"); offerCreation("relationships", "r"); offerCreation("objectives", "o");
  const sortedReplacements = [...replacements].sort((a, b) => b[0].length - a[0].length);
  const rewriteText = text => {
    let result = String(text ?? "");
    for (const [id, alias] of sortedReplacements) result = result.replaceAll(id, alias);
    return result;
  };
  const aliasFor = (kind, id) => {
    const alias = forward[kind]?.get(id);
    if (!alias) throw new Error(`No backend alias exists for a ${kind} reference`);
    return alias;
  };
  const allocate = alias => {
    if (allocated.has(alias)) return allocated.get(alias);
    const entry = creation.get(alias);
    const prefix = { characters: entry?.role === "user" ? "user" : "npc", places: "place", relationships: "rel", objectives: "objective" }[entry?.kind];
    if (!prefix) throw new Error("Unknown creation alias");
    let id = prefix === "user" ? "user" : `${prefix}:${allocateId()}`;
    let attempts = 0;
    while (forward[entry.kind].has(id) || [...allocated.values()].some(record => record.kind === entry.kind && record.id === id)) {
      if (++attempts > 8 || prefix === "user") throw new Error("Could not allocate a unique entity id");
      id = `${prefix}:${allocateId()}`;
    }
    const record = { ...entry, id }; allocated.set(alias, record); return record;
  };
  return { forward, reverse, creation, aliasFor, allocate, rewriteText };
}

function rewriteAliasValues(value, rewriteText) {
  if (typeof value === "string") return rewriteText(value);
  if (Array.isArray(value)) return value.map(entry => rewriteAliasValues(entry, rewriteText));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteAliasValues(entry, rewriteText)]));
  return value;
}

export function encodeModelState(state, registry) {
  if (!state) return null;
  const result = rewriteAliasValues(state, registry.rewriteText);
  for (const kind of Object.keys(ALIAS_LIMITS)) for (let index = 0; index < (state[kind]?.length ?? 0); index++) {
    const input = state[kind][index], output = result[kind][index];
    output.id = registry.aliasFor(kind, input.id);
    if (kind === "relationships") { output.fromId = registry.aliasFor("characters", input.fromId); output.toId = registry.aliasFor("characters", input.toId); }
    if (kind === "objectives") output.ownerId = registry.aliasFor("characters", input.ownerId);
    delete output.sourceMessageId;
  }
  if (result.world) delete result.world.sourceMessageId;
  return result;
}

export function encodeModelSources(sources, registry) {
  const cards = (sources.cards ?? []).map(card => ({ id: registry.aliasFor("characters", `char:${card.id}`), name: card.name,
    description: card.description ?? "", personality: card.personality ?? "", scenario: card.scenario ?? "",
    exampleDialogue: card.exampleDialogue ?? card.mes_example ?? "", creatorNotes: card.creatorNotes ?? card.creator_notes ?? "",
    selectedGreeting: card.selectedGreeting ?? card.first_mes ?? "" }));
  const lore = (sources.lore ?? []).map(entry => ({ id: registry.aliasFor("lore", `lore:${entry.id}`), content: entry.content }));
  return rewriteAliasValues({ cards, selectedOpening: sources.selectedOpening ?? "", lore }, registry.rewriteText);
}

export function encodeModelReferences(references, registry) {
  return references.map(reference => ({ ...rewriteAliasValues(reference, registry.rewriteText),
    ownerId: registry.forward.characters.has(reference.ownerId) ? registry.aliasFor("characters", reference.ownerId) : registry.aliasFor("lore", reference.ownerId) }));
}

export function modelAliasCatalog(registry, { allowedUpdateIds } = {}) {
  const existing = Object.fromEntries(Object.keys(ALIAS_LIMITS).map(kind => [kind, []]));
  for (const [id, record] of registry.reverse) if (existing[record.kind]) existing[record.kind].push({ id,
    canUpdate: !allowedUpdateIds || Boolean(allowedUpdateIds[record.kind]?.has(record.id)),
    ...(record.name ? { name: record.name } : {}), ...(record.role ? { role: record.role, controller: record.controller } : {}) });
  return rewriteAliasValues({ existing, creation: Object.fromEntries(Object.keys(ALIAS_LIMITS).map(kind => [kind, [...registry.creation].filter(([, record]) => record.kind === kind).map(([alias]) => alias)])) }, registry.rewriteText);
}

export function aliasOutputSchema(registry, { allowedUpdateIds } = {}) {
  const schema = structuredClone(TRACKER_OUTPUT_JSON_SCHEMA);
  const idsFor = (kind, selectedOnly = false) => [...registry.reverse].filter(([, record]) => record.kind === kind
    && (!selectedOnly || !allowedUpdateIds || allowedUpdateIds[kind]?.has(record.id))).map(([alias]) => alias)
    .concat([...registry.creation].filter(([, record]) => record.kind === kind).map(([alias]) => alias));
  for (const kind of Object.keys(ALIAS_LIMITS)) {
    const properties = schema.properties[kind].items.properties;
    const outputIds = idsFor(kind, true);
    // A full, entirely unselected collection must be empty; never emit an invalid empty enum.
    properties.id = { type: "string", enum: outputIds.length ? outputIds : idsFor(kind) };
    if (!outputIds.length) schema.properties[kind].maxItems = 0;
    if (kind === "relationships") for (const key of ["fromId", "toId"]) properties[key] = { type: "string", enum: idsFor("characters") };
    if (kind === "objectives") properties.ownerId = { type: "string", enum: idsFor("characters") };
  }
  return schema;
}

export function decodeModelOutput(output, registry) {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Tracker must return a JSON object");
  const decoded = structuredClone(output), declaredNew = new Set(), resolved = new Map();
  // Validate identities first. A creation reference must have its own declared record.
  for (const kind of Object.keys(ALIAS_LIMITS)) {
    if (!Array.isArray(decoded[kind])) throw new Error(`${kind} must be an array`);
    const seen = new Set();
    for (const entry of decoded[kind]) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string") throw new Error(`${kind}.id must be a supplied short alias`);
      const alias = entry.id.trim();
      if (seen.has(alias)) throw new Error(`${kind} contains duplicate aliases`);
      seen.add(alias);
      let record = registry.reverse.get(alias);
      if (!record) {
        const offered = registry.creation.get(alias);
        if (!offered || offered.kind !== kind) throw new Error(`${kind}.id is unknown; use an existing alias or a supplied creation alias`);
        if (entry.action !== "update") throw new Error("A creation alias requires action update");
        record = registry.allocate(alias); declaredNew.add(alias);
      }
      if (record.kind !== kind) throw new Error(`${kind}.id belongs to a different entity type`);
      if (kind === "characters" && (entry.role !== record.role || entry.controller !== record.controller)) throw new Error("Character alias role/controller does not match its backend identity");
      if (kind === "characters" && registry.reverse.has(alias) && entry.action === "update" && normalizedAliasName(entry.name) !== normalizedAliasName(record.name)) {
        const other = [...registry.reverse.values()].find(candidate => candidate.kind === "characters" && candidate.id !== record.id && normalizedAliasName(candidate.name) === normalizedAliasName(entry.name));
        if (other) throw new Error("Character alias/name pair belongs to another established character");
      }
      resolved.set(alias, { ...record, name: entry.action === "preserve" ? record.name : entry.name ?? record.name }); entry.id = record.id;
    }
  }
  const resolveCharacter = (value, path) => {
    if (typeof value !== "string") throw new Error(`${path} must be a character alias`);
    const alias = value.trim(), record = registry.reverse.get(alias) ?? (declaredNew.has(alias) ? resolved.get(alias) : null);
    if (!record || record.kind !== "characters") throw new Error(`${path} references an unknown or undeclared character alias`);
    return record.id;
  };
  for (const relationship of decoded.relationships) {
    relationship.fromId = resolveCharacter(relationship.fromId, "relationships.fromId");
    relationship.toId = resolveCharacter(relationship.toId, "relationships.toId");
  }
  for (const objective of decoded.objectives) objective.ownerId = resolveCharacter(objective.ownerId, "objectives.ownerId");
  // Descriptive text uses names; the persistent record must not depend on ephemeral aliases.
  const proseLabels = new Map([...new Map([...registry.reverse, ...resolved])].filter(([, record]) => record.kind === "characters" || record.kind === "places")
    .map(([alias, record]) => [alias, record.name]).filter(([, name]) => typeof name === "string" && name));
  const prosePattern = proseLabels.size ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...proseLabels.keys()].map(aliasRegexEscape).join("|")})(?![\\p{L}\\p{N}_])`, "gu") : null;
  const proseRewrite = text => prosePattern ? text.replace(prosePattern, alias => proseLabels.get(alias)) : text;
  if (decoded.world) decoded.world = rewriteAliasValues(decoded.world, proseRewrite);
  for (const kind of Object.keys(ALIAS_LIMITS)) for (const entry of decoded[kind]) {
    for (const key of Object.keys(entry)) if (!["id", "fromId", "toId", "ownerId", "role", "controller", "action", "name"].includes(key)) entry[key] = rewriteAliasValues(entry[key], proseRewrite);
  }
  return decoded;
}
