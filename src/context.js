import { compactPromptState, trackerStateForLlm } from "./schemas.js";
import { createAliasRegistry, encodeModelState } from "./aliases.js";
import { renderContinuityContext, hasPromptValue } from "./render.js";

export const ROLEPLAY_CONTEXT_CHARS = 24000;
export const SOURCE_REFERENCE_CHARS = 6000;
const contextNormalize = text => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const contextWords = text => new Set(contextNormalize(text).split(" ").filter(word => word.length > 2 && word !== "unknown"));
const hasKnownValue = hasPromptValue;
const phraseMentioned = (text, phrase) => { const normalized = contextNormalize(phrase); return normalized && (` ${contextNormalize(text)} `).includes(` ${normalized} `); };
const LOCATION_STOP_WORDS = new Set("a an the at in on by near inside outside within beneath under above beside of to".split(" "));

function placesAtLocation(places, location) {
  if (!hasKnownValue(location)) return [];
  const named = places.filter(place => phraseMentioned(location, place.name) || phraseMentioned(location, place.id));
  if (named.length) return named;
  // Resolve a sublocation only when its words identify one saved place. Connections
  // and private/current facts are not evidence that the scene is at a destination.
  const words = contextNormalize(location).split(" ").filter(word => word && word !== "unknown" && !LOCATION_STOP_WORDS.has(word));
  if (!words.length) return [];
  const matches = places.filter(place => words.every(word => phraseMentioned(`${place.name} ${place.description}`, word)));
  return matches.length === 1 ? matches : [];
}

// Selection operates on committed state only; it never invents presence or changes storage.
export function selectRelevantState(state, text = "", { focusCharacterId } = {}) {
  const focusId = state.characters.some(char => char.id === focusCharacterId) ? focusCharacterId : `char:${focusCharacterId}`;
  const focus = state.characters.find(char => char.id === focusId) ?? state.characters.find(char => char.role === "main") ?? state.characters[0];
  const currentPlaces = placesAtLocation(state.places, state.world.location);
  const locationWords = contextWords([state.world.location, ...currentPlaces.map(place => `${place.name} ${place.description}`)].join(" "));
  const ranked = state.characters.map((char, index) => {
    const mentioned = phraseMentioned(text, char.name) || phraseMentioned(text, char.id);
    const colocated = hasKnownValue(char.visible.position) && [...contextWords(char.visible.position)].some(word => locationWords.has(word));
    const contact = phraseMentioned(state.world.proximityAndContact, char.name);
    const score = char.id === focus?.id ? 1000 : mentioned ? 900 : char.role === "user" ? 800 : contact ? 700 : colocated ? 600 : 0;
    return { char, score, index };
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const characters = ranked.map(entry => entry.char), ids = new Set(characters.map(char => char.id));
  const relationships = state.relationships.filter(rel => ids.has(rel.fromId) && ids.has(rel.toId));
  const positionedPlaces = new Set(characters.flatMap(char => placesAtLocation(state.places, char.visible.position)));
  const places = state.places.filter(place => currentPlaces.includes(place) || positionedPlaces.has(place) || phraseMentioned(text, place.name) || phraseMentioned(text, place.id));
  const objectives = state.objectives.filter(objective => ids.has(objective.ownerId) && (objective.status === "active" || phraseMentioned(text, objective.id)));
  return { schemaVersion: state.schemaVersion, world: state.world, characters, relationships, places, objectives };
}

// Whole values are admitted or omitted; neither profiles nor current state are truncated.
// A projection is never parsed back as canonical state.
export function buildRoleplayContext(state, text = "", options = {}) {
  const selected = selectRelevantState(state, text, options);
  const compact = encodeModelState(compactPromptState(selected), createAliasRegistry(options.sources, state));
  const limit = Math.max(1200, Math.min(64000, options.maxChars ?? ROLEPLAY_CONTEXT_CHARS));
  const projection = { omittedCharacters: state.characters.length - selected.characters.length,
    omittedPlaces: state.places.length - selected.places.length, omittedFields: false };
  const result = { schemaVersion: state.schemaVersion, world: {}, characters: [], relationships: [], places: [], objectives: [], projection };
  const visualOnly = options.visualOnly === true;
  // Reserve the longest omission notice so a later omission cannot exceed the cap.
  const fits = () => renderContinuityContext({ ...result, projection: {
    omittedCharacters: state.characters.length, omittedPlaces: state.places.length, omittedFields: true,
  } }, { visualOnly }).length <= limit;
  const add = (target, key, value) => {
    if (!hasKnownValue(value)) return;
    target[key] = structuredClone(value);
    if (!fits()) { delete target[key]; projection.omittedFields = true; }
  };
  // Reserve identities before filling longer fields, so every selected actor remains named.
  for (const char of compact.characters ?? []) {
    const record = { id: char.id, name: char.name, role: char.role, controller: char.controller };
    result.characters.push(record);
    if (!fits()) { result.characters.pop(); projection.omittedCharacters++; }
  }
  for (const key of ["date", "time", "location", "sceneStatus", "immediateContext", "proximityAndContact", "weather"]) add(result.world, key, compact.world[key]);
  // Fill each priority across the selected cast before spending space on history.
  const characterFields = (section, fields) => {
    for (const record of result.characters) {
      const char = compact.characters.find(char => char.id === record.id);
      record[section] ??= {};
      for (const key of fields) add(record[section], key, char[section]?.[key]);
      if (!Object.keys(record[section]).length) delete record[section];
    }
  };
  const records = (key, entries) => {
    for (const entry of entries) {
      result[key].push(entry);
      if (!fits()) { result[key].pop(); projection.omittedFields = true; if (key === "places") projection.omittedPlaces++; }
    }
  };
  characterFields("visible", ["position", "physicalState", "dressAndLayers", "items", "activity", "hairAndGrooming"]);
  if (!visualOnly) {
    characterFields("profile", ["boundaries"]);
    characterFields("internal", ["knowledge", "beliefs", "intent"]);
    const ids = new Set(result.characters.map(char => char.id));
    records("relationships", (compact.relationships ?? []).filter(rel => ids.has(rel.fromId) && ids.has(rel.toId)));
    records("objectives", (compact.objectives ?? []).filter(objective => ids.has(objective.ownerId)));
  }
  // Visual exports never admit private fields into their intermediate projection.
  records("places", (compact.places ?? []).map(place => {
    const { privateFacts, ...visible } = place;
    return visible;
  }));
  characterFields("appearance", ["face", "eyes", "skin", "body", "distinguishingFeatures"]);
  if (!visualOnly) {
    characterFields("internal", ["mood", "concerns"]);
    characterFields("profile", ["relationshipContext", "identity", "personality", "preferences", "privateFacts", "background"]);
    for (const place of result.places) add(place, "privateFacts", compact.places.find(entry => entry.id === place.id)?.privateFacts);
  }
  return result;
}

export function buildVisualContext(state, options = {}) {
  return renderContinuityContext(buildRoleplayContext(state, "", { ...options, visualOnly: true }), { visualOnly: true });
}

const REFERENCE_STOP_WORDS = new Set("the and with from that this their them they her his she him has have had are was were its into about for but not only always never very can could would should when then what who how does did says say according original card profile source please check verify remember unknown".split(" "));
const REFERENCE_TOPICS = [
  ["food", "eat", "eating", "meal", "dinner", "lunch", "breakfast", "restaurant", "allergy", "allergic", "allergies", "shellfish", "shrimp", "peanut", "vegetarian", "vegan"],
  ["family", "mother", "father", "parent", "parents", "sister", "brother", "child", "children", "spouse", "married", "marriage", "divorced"],
  ["boundary", "boundaries", "privacy", "permission", "limits", "touch", "refusal", "consent", "dealbreaker", "dealbreakers"],
  ["voice", "accent", "speech", "speaks", "personality", "temperament", "habit", "habits"],
  ["health", "injury", "injured", "condition", "medicine", "medical", "disability", "illness"],
];
const meaningfulWords = text => [...contextWords(text)].filter(word => !REFERENCE_STOP_WORDS.has(word));
function sourcePassages(text) {
  const result = [];
  for (const passage of String(text ?? "").split(/\n+|(?<=[.!?。！？])\s+/u).map(value => value.trim()).filter(Boolean)) {
    if (passage.length <= 1400) { result.push({ excerpt: passage, partial: false }); continue; }
    for (let offset = 0; offset < passage.length; offset += 1000) result.push({ excerpt: passage.slice(Math.max(0, offset - 150), offset + 1150), partial: true });
  }
  return result;
}

// Search the frozen source snapshot locally. Guidance/examples and the original opening
// are excluded: they must not be promoted into new facts or reset a progressed scene.
export function lookupSourceReferences(sources, state, text, { maxChars = SOURCE_REFERENCE_CHARS, eligibleOwnerIds } = {}) {
  if (!sources || !text.trim()) return [];
  const query = new Set(meaningfulWords(text));
  // Mentioning an actor alone is not a reason to resend their biography.
  for (const entity of [...state.characters, ...state.places]) for (const word of meaningfulWords(entity.name)) query.delete(word);
  const expanded = new Set(query);
  for (const topic of REFERENCE_TOPICS) if (topic.some(word => query.has(word))) for (const word of topic) expanded.add(word);
  const stableText = char => [char.name, ...Object.values(char.profile), ...Object.values(char.appearance)].filter(hasKnownValue).join(" ");
  const globalKnown = [...state.characters.map(stableText), ...state.places.flatMap(place => [place.name, place.description, place.connections, place.privateFacts])].filter(hasKnownValue).join(" ");
  const candidates = [];
  const eligible = eligibleOwnerIds ?? new Set(selectRelevantState(state, text).characters.map(char => char.id));
  for (const card of sources.cards ?? []) {
    if (!eligible.has(`char:${card.id}`)) continue;
    for (const field of ["description", "personality", "scenario"]) for (const passage of sourcePassages(card[field])) candidates.push({ ownerId: `char:${card.id}`, field, ...passage });
  }
  for (const lore of sources.lore ?? []) for (const passage of sourcePassages(lore.content)) candidates.push({ ownerId: `lore:${lore.id}`, field: "constantLore", ...passage });
  const ranked = candidates.map((candidate, index) => {
    const owner = state.characters.find(char => char.id === candidate.ownerId);
    const knownText = contextNormalize(owner ? stableText(owner) : globalKnown);
    const knownWords = new Set(meaningfulWords(knownText));
    const words = meaningfulWords(candidate.excerpt);
    const direct = words.filter(word => query.has(word)).length;
    const topical = words.filter(word => expanded.has(word)).length;
    const covered = knownText.includes(contextNormalize(candidate.excerpt)) || words.length > 0 && words.filter(word => knownWords.has(word)).length / words.length >= .85;
    const score = covered ? 0 : direct * 3 + topical;
    return { candidate, index, score };
  }).filter(entry => entry.score >= 2).sort((a, b) => b.score - a.score || a.index - b.index);
  const excerpts = [], seen = new Set();
  for (const { candidate } of ranked) {
    const key = contextNormalize(candidate.excerpt);
    if (seen.has(key)) continue;
    excerpts.push(candidate);
    if (JSON.stringify(excerpts).length > maxChars) { excerpts.pop(); continue; }
    seen.add(key);
    if (excerpts.length === 8) break;
  }
  return excerpts;
}

export function buildRoutineTrackerContext(input) {
  const turnText = `${input.userText ?? ""}\n${input.assistantText ?? ""}`;
  const selected = selectRelevantState(input.previousState, turnText, input);
  const references = lookupSourceReferences(input.sources, input.previousState, turnText, { eligibleOwnerIds: new Set(selected.characters.map(char => char.id)) });
  // A source excerpt may concern an existing absent character, requiring its saved profile.
  const ids = new Set(selected.characters.map(char => char.id));
  for (const ref of references) if (!ids.has(ref.ownerId)) {
    const char = input.previousState.characters.find(char => char.id === ref.ownerId);
    if (char) { selected.characters.push(char); ids.add(char.id); }
  }
  return { state: trackerStateForLlm(selected), references,
    identities: { characters: input.previousState.characters.map(char => ({ id: char.id, name: char.name, role: char.role, controller: char.controller })),
      places: input.previousState.places.map(place => ({ id: place.id, name: place.name })) },
    allowedUpdateIds: Object.fromEntries(["characters", "relationships", "places", "objectives"].map(key => [key, new Set(selected[key].map(entry => entry.id))])) };
}
