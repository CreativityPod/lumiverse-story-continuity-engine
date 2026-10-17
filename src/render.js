import { formatStoryClockValue } from "./clock.js";

// Prompt-only presentation. Canonical state and the tracker protocol stay JSON.
export const IDENTITY_LABELS = { age: "AGE", gender: "GENDER" };
export const APPEARANCE_LABELS = { face: "FACE", eyes: "EYES", skin: "SKIN", body: "BODY TYPE & PROPORTIONS", distinguishingFeatures: "DISTINGUISHING FEATURES" };
export const VISIBLE_LABELS = { hairAndGrooming: "HAIR & GROOMING", dressAndLayers: "DRESS & LAYERS", physicalState: "PHYSICAL STATE", position: "POSITION", activity: "ACTIVITY", items: "ITEMS" };
const PROFILE_LABELS = { identity: "IDENTITY", background: "BACKGROUND", personality: "PERSONALITY & VOICE", preferences: "PREFERENCES", relationshipContext: "RELATIONSHIP HISTORY & AGREEMENTS", boundaries: "BOUNDARIES", privateFacts: "PRIVATE FACTS" };
const INTERNAL_LABELS = { mood: "MOOD", intent: "INTENT", knowledge: "KNOWLEDGE", beliefs: "BELIEFS", concerns: "CONCERNS" };
export const hasPromptValue = value => typeof value === "string" && Boolean(value.trim()) && !/^unknown\.?$/i.test(value.trim());
const promptValue = value => String(value).replace(/\r\n?/g, "\n").replace(/\n/g, "\n  ");
const promptFields = (record, labels) => Object.entries(labels).filter(([key]) => hasPromptValue(record?.[key]))
  .map(([key, label]) => `${label}: ${promptValue(record[key])}`).join("; ");

export function renderContinuityContext(context, { visualOnly = false } = {}) {
  const world = context.world ?? {}, characters = context.characters ?? [], places = context.places ?? [];
  const lines = ["CURRENT SCENE"];
  const when = ["date", "time"].filter(key => hasPromptValue(world[key])).map(key => promptValue(formatStoryClockValue(key, world[key]))).join("; ");
  if (when) lines.push(`WHEN: ${when}`);
  for (const [key, label] of Object.entries({ sceneStatus: "LIFECYCLE", weather: "WEATHER", location: "LOCATION", immediateContext: "CONTEXT", proximityAndContact: "PROXIMITY & CONTACT" })) {
    if (hasPromptValue(world[key])) lines.push(`${label}: ${promptValue(world[key])}`);
  }
  for (const char of characters) {
    lines.push("", `CHARACTER ${char.id}: ${promptValue(char.name)}`);
    const identity = promptFields(char.profile, IDENTITY_LABELS);
    if (identity) lines.push(identity);
    if (!visualOnly) lines.push(`ROLE: ${char.role}; CONTROL: ${char.controller}`);
    const stable = promptFields(char.appearance, APPEARANCE_LABELS), visible = promptFields(char.visible, VISIBLE_LABELS);
    if (stable) lines.push(`STABLE APPEARANCE: ${stable}`);
    if (visible) lines.push(`CURRENT VISIBLE: ${visible}`);
  }
  for (const place of places) {
    const details = promptFields(place, { description: "DESCRIPTION", currentState: "CURRENT STATE", connections: "CONNECTIONS" });
    lines.push("", `PLACE ${place.id}: ${promptValue(place.name)}`);
    if (details) lines.push(details);
  }
  if (!visualOnly) {
    const privateCharacters = characters.flatMap(char => {
      const profile = promptFields(char.profile, PROFILE_LABELS), internal = promptFields(char.internal, INTERNAL_LABELS);
      return profile || internal ? [`CHARACTER ${char.id}: ${promptValue(char.name)}`, ...(profile ? [`STABLE PROFILE: ${profile}`] : []), ...(internal ? [`PRIVATE STATE: ${internal}`] : [])] : [];
    });
    if (privateCharacters.length) lines.push("", "PRIVATE CHARACTER CONTEXT — knowledge belongs to each character individually", ...privateCharacters);
    const named = id => { const char = characters.find(char => char.id === id); return char ? `${id} (${promptValue(char.name)})` : id; };
    const arc = [];
    for (const rel of context.relationships ?? []) {
      arc.push(`RELATIONSHIP ${rel.id}: ${named(rel.fromId)} -> ${named(rel.toId)}`);
      const details = promptFields(rel, { publicStatus: "PUBLIC STATUS", privateState: "PRIVATE STATE", boundaryOrConcern: "BOUNDARY OR CONCERN" });
      if (details) arc.push(details);
    }
    for (const objective of context.objectives ?? []) {
      arc.push(`OBJECTIVE ${objective.id}: OWNER: ${named(objective.ownerId)}; ${promptFields(objective, { objective: "OBJECTIVE", status: "STATUS", timing: "TIMING" })}`);
    }
    if (arc.length) lines.push("", "CURRENT ARC — relationships and commitments", ...arc);
    const privatePlaces = places.filter(place => hasPromptValue(place.privateFacts)).map(place => `PLACE ${place.id} (${promptValue(place.name)}): ${promptValue(place.privateFacts)}`);
    if (privatePlaces.length) lines.push("", "PRIVATE PLACE CONTEXT", ...privatePlaces);
  }
  if (context.projection) {
    const { omittedCharacters, omittedPlaces, omittedFields } = context.projection;
    lines.push("", `CONTEXT COVERAGE: ${omittedCharacters} characters and ${omittedPlaces} places omitted; additional fields or records omitted: ${omittedFields ? "yes" : "no"}. Omission does not erase established facts or make them unknown. Do not invent omitted details.`);
  }
  return lines.join("\n");
}
