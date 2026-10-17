import { cloneEmptyState, trackerStateForLlm } from "../src/schemas.js";
import { createAliasRegistry } from "../src/aliases.js";

export const CARD = { id: "ada", name: "Ada", description: "Ada is a mechanic with black hair. Her secret affiliation is the Lantern Guild.", personality: "Wary, practical, and patient.", scenario: "A rainy railway station at midnight.", first_mes: "Ada waits beneath the platform clock, wearing a blue coat.", mes_example: "Ada: I once visited the moon. [Example only]", creator_notes: "Use a restrained voice.", world_book_ids: [] };
export const SOURCES = { cards: [CARD], selectedOpening: CARD.first_mes, lore: [] };
export function character(id = "char:ada", role = "main") {
  return { id, name: id === "user" ? "Traveler" : "Ada", role, controller: role === "user" ? "user" : "model",
    profile: { age: "Unknown", gender: "Unknown", identity: "Mechanic", background: "Works at the station", personality: "Wary and patient", preferences: "Honesty", relationshipContext: "Unknown", boundaries: "Unknown", privateFacts: "Lantern Guild affiliation" },
    appearance: { face: "Angular", eyes: "Brown", skin: "Unknown", body: "Unknown", distinguishingFeatures: "Unknown" },
    visible: { hairAndGrooming: "Black hair", dressAndLayers: "Blue coat", physicalState: "Uninjured", position: "Platform", activity: "Waiting", items: "Toolbag" },
    internal: { mood: "Wary", intent: "Repair the signal", knowledge: "Knows the signal is faulty", beliefs: "Unknown", concerns: "Unknown" }, sourceMessageId: "card-baseline" };
}
export function fixtureState() {
  const state = cloneEmptyState(); state.world = { ...state.world, date: "October 13", time: "Midnight", weather: "Rain", location: "Railway station" };
  state.characters = [character()];
  state.places = [{ id: "place:station", name: "Station", description: "A covered platform", currentState: "Side door locked", connections: "Town road", privateFacts: "Hidden tunnel", sourceMessageId: "card-baseline" }];
  return state;
}
export function outputState(state = fixtureState()) {
  const output = trackerStateForLlm(state);
  for (const section of [output.world, ...output.characters, ...output.places, ...output.relationships, ...output.objectives]) section.action = "update";
  return output;
}

// Mock the provider protocol using the catalog for the actual request, not proposed storage.
export function modelOutput(state = fixtureState(), { sources = SOURCES, previousState = state, initialize = false } = {}) {
  const registry = createAliasRegistry(sources, initialize ? null : previousState), output = outputState(state);
  const aliases = Object.fromEntries(["characters", "places", "relationships", "objectives"].map(kind => [kind, new Map()])), used = new Set();
  for (const kind of Object.keys(aliases)) for (const entry of state[kind]) {
    let alias = registry.forward[kind].get(entry.id);
    if (!alias) alias = [...registry.creation].find(([id, record]) => record.kind === kind && (!record.role || record.role === entry.role) && !used.has(id))?.[0];
    if (!alias) throw new Error("Fixture has no available entity alias");
    aliases[kind].set(entry.id, alias); used.add(alias);
  }
  for (const kind of Object.keys(aliases)) for (const entry of output[kind]) {
    entry.id = aliases[kind].get(entry.id);
    if (kind === "relationships") { entry.fromId = aliases.characters.get(entry.fromId); entry.toId = aliases.characters.get(entry.toId); }
    if (kind === "objectives") entry.ownerId = aliases.characters.get(entry.ownerId);
  }
  return output;
}
