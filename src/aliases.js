import { TRACKER_SCHEMA_VERSION, TRACKER_OUTPUT_JSON_SCHEMA, validateTrackerRecord, cloneEmptyState, partialTrackerPreview } from "./schemas.js";
import { TRACKER_COLLECTIONS, TrackerValidationError, expandTrackerRecord, trackerPatchRecordSchema } from "./protocol.js";
import { applyInitialWorldDefaults } from "./clock.js";

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
  return { forward, reverse, creation, aliasFor, allocate, rewriteText, previousState: state };
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
  return rewriteAliasValues({ existing, creation: Object.fromEntries(Object.keys(ALIAS_LIMITS).map(kind => [kind, [...registry.creation].filter(([, record]) => record.kind === kind).map(([alias]) => alias)])),
    creationRule: "A creation alias is an available slot, not an established character. Declare its character record with action update and a name from the story before referencing it. For the user, User is an acceptable neutral label when no name is established. Omitted character facts become Unknown; never invent a biography or user thoughts." }, registry.rewriteText);
}

export function aliasOutputSchema(registry, { allowedUpdateIds, patches = false } = {}) {
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
  if (patches) {
    schema.properties.world = trackerPatchRecordSchema("world");
    for (const kind of TRACKER_COLLECTIONS) schema.properties[kind].items = trackerPatchRecordSchema(kind, schema.properties[kind].items.properties.id);
  }
  return schema;
}

export function decodeModelOutput(output, registry, { sourceMessageId = "card-baseline", requireInitialScene = false, initialWorldDefaults = null } = {}) {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Tracker must return a JSON object");
  if (output.schemaVersion !== TRACKER_SCHEMA_VERSION) throw new Error(`Tracker object must have schemaVersion ${TRACKER_SCHEMA_VERSION}`);
  if (Object.keys(output).some(key => !["schemaVersion", "world", ...TRACKER_COLLECTIONS].includes(key))) throw new Error("Tracker object has unexpected root fields");
  const decoded = structuredClone(output), declaredNew = new Set(), resolved = new Map(), issues = [];
  const issue = (kind, index, alias, path, error, code = "invalid_record") => issues.push({ kind, index, recordId: alias, path: error.path ?? (error.field ? `${path}.${error.field}` : path),
    code: error.code ?? code, message: String(error.message ?? error).slice(0, 1000) });
  const modelPrior = (kind, record) => {
    if (!record?.prior) return null;
    return encodeModelState({ [kind]: [record.prior] }, registry)[kind][0];
  };
  try {
    if (!decoded.world || typeof decoded.world !== "object" || Array.isArray(decoded.world)) throw new Error("world must be an object");
    const { sourceMessageId: ignored, ...priorWorld } = registry.previousState?.world ?? cloneEmptyState().world;
    decoded.world = expandTrackerRecord(decoded.world, "world", priorWorld);
    if (requireInitialScene && initialWorldDefaults) decoded.world = applyInitialWorldDefaults(decoded.world, initialWorldDefaults);
    decoded.world = validateTrackerRecord(decoded.world, "world", "world");
  } catch (error) { issue("world", 0, "world", "world", error); }
  // Validate identities first. A creation reference must have its own declared record.
  for (const kind of Object.keys(ALIAS_LIMITS)) {
    if (!Array.isArray(decoded[kind]) || decoded[kind].length > ALIAS_LIMITS[kind]) {
      issue(kind, -1, null, kind, `${kind} exceeds its list limit or must be an array`); continue;
    }
    const seen = new Set();
    for (let index = 0; index < decoded[kind].length; index++) {
      let entry = decoded[kind][index];
      const path = `${kind}[${index}]`, offeredAlias = typeof entry?.id === "string" ? entry.id.trim() : null;
      try {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string") throw new Error(`${kind}.id must be a supplied short alias`);
        const alias = entry.id.trim();
        if (seen.has(alias)) throw new Error(`${kind} contains duplicate aliases`);
        seen.add(alias);
        let record = registry.reverse.get(alias);
        if (!record) {
          const offered = registry.creation.get(alias);
          if (!offered || offered.kind !== kind) throw new Error(`${kind}.id is unknown; use an existing alias or a supplied creation alias`);
          if (entry.action && entry.action !== "update") throw new Error("A creation alias requires action update");
          record = registry.allocate(alias);
        }
        if (record.kind !== kind) throw new Error(`${kind}.id belongs to a different entity type`);
        if (kind === "characters" && entry.action === "preserve" && ["role", "controller"].some(key => entry[key] !== undefined && entry[key] !== record[key])) throw new Error("Character alias role/controller does not match its backend identity");
        entry = expandTrackerRecord({ ...entry, id: alias }, kind, modelPrior(kind, record), {
          ...(kind === "characters" ? { name: record.name ?? "Unknown", role: record.role, controller: record.controller } : {}), id: alias,
        });
        entry = validateTrackerRecord(entry, kind, path);
        if (kind === "characters" && !record.prior && entry.name.toLowerCase() === "unknown") throw new Error("A new character declaration requires an established name or the neutral user label User");
        if (kind === "characters" && (entry.role !== record.role || entry.controller !== record.controller)) throw new Error("Character alias role/controller does not match its backend identity");
        if (kind === "characters" && registry.reverse.has(alias) && entry.action === "update" && normalizedAliasName(entry.name) !== normalizedAliasName(record.name)) {
          const other = [...registry.reverse.values()].find(candidate => candidate.kind === "characters" && candidate.id !== record.id && normalizedAliasName(candidate.name) === normalizedAliasName(entry.name));
          if (other) throw new Error("Character alias/name pair belongs to another established character");
        }
        if (kind === "characters" && entry.controller === "user" && Object.values(entry.internal).some(value => value !== "Unknown")) throw new Error("User internal state must remain Unknown");
        resolved.set(alias, { ...record, name: entry.action === "preserve" ? record.name : entry.name ?? record.name });
        if (registry.creation.has(alias)) declaredNew.add(alias);
        entry.id = record.id; decoded[kind][index] = entry;
      } catch (error) { issue(kind, index, offeredAlias, path, error); }
    }
  }
  const resolveCharacter = (value, path, kind, index, recordId) => {
    const alias = value.trim(), record = registry.reverse.get(alias) ?? (declaredNew.has(alias) ? resolved.get(alias) : null);
    if (!record || record.kind !== "characters") {
      const offered = registry.creation.get(alias)?.kind === "characters";
      issue(kind, index, recordId, path, `references an unknown or undeclared character alias ${JSON.stringify(alias)}${offered ? "; include this character's declaration with action update and its name in characters" : "; use a supplied character alias, never a name, canonical id or place alias"}`, offered ? "missing_declaration" : "invalid_reference");
      return value;
    }
    return record.id;
  };
  for (const kind of ["relationships", "objectives"]) if (Array.isArray(decoded[kind])) for (const [index, entry] of decoded[kind].entries()) {
    if (issues.some(error => error.kind === kind && error.index === index)) continue;
    const recordId = output[kind][index].id.trim();
    const record = resolved.get(recordId);
    if (entry.action === "preserve") {
      // Endpoints already came from the saved record; do not interpret their
      // canonical ids as model-supplied aliases a second time.
      if (kind === "relationships") { entry.fromId = record.prior.fromId; entry.toId = record.prior.toId; }
      else entry.ownerId = record.prior.ownerId;
      continue;
    }
    for (const field of kind === "relationships" ? ["fromId", "toId"] : ["ownerId"]) entry[field] = resolveCharacter(entry[field], `${kind}[${index}].${field}`, kind, index, recordId);
    if (kind === "relationships" && entry.fromId === entry.toId) issue(kind, index, recordId, `${kind}[${index}]`, "Relationship references must identify two different established characters");
  }
  // These requirements must join reference/record errors BEFORE the single
  // repair is requested. Otherwise repairing a dangling reference can reveal
  // missing starting values only after the repair budget has already been used.
  if (requireInitialScene) {
    const missing = value => typeof value === "string" && /^unknown\.?$/i.test(value.trim());
    for (const field of ["date", "time", "weather"]) if (missing(decoded.world?.[field])) {
      issue("world", 0, "world", `world.${field}`, `Initial scene requires world.${field}; preserve the source value or choose a compatible fictional starting default under the initialization-only policy`, "missing_initial_value");
    }
    if (Array.isArray(decoded.characters)) for (const [index, char] of decoded.characters.entries()) {
      if (issues.some(error => error.kind === "characters" && (error.index === index || error.index === -1))) continue;
      if (char.controller === "model" && missing(char.visible?.dressAndLayers)) {
        issue("characters", index, output.characters[index].id.trim(), `characters[${index}].visible.dressAndLayers`,
          `Initial scene requires visible.dressAndLayers for ${JSON.stringify(char.name)}; preserve source clothing or choose a compatible starting outfit, including an explicit clothing condition when an outfit does not apply. Never choose the user's outfit`, "missing_initial_value");
      }
    }
  }
  if (issues.length) {
    const error = new TrackerValidationError(issues);
    error.preview = partialTrackerPreview(decoded, issues, registry.previousState, sourceMessageId);
    throw error;
  }
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
