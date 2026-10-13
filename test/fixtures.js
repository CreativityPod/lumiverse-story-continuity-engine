import { cloneEmptyState, trackerStateForLlm } from "../src/schemas.js";

export const CARD = { id: "ada", name: "Ada", description: "Ada is a mechanic with black hair. Her secret affiliation is the Lantern Guild.", personality: "Wary, practical, and patient.", scenario: "A rainy railway station at midnight.", first_mes: "Ada waits beneath the platform clock, wearing a blue coat.", mes_example: "Ada: I once visited the moon. [Example only]", creator_notes: "Use a restrained voice.", world_book_ids: [] };
export const SOURCES = { cards: [CARD], selectedOpening: CARD.first_mes, lore: [] };
export function character(id = "char:ada", role = "main") {
  return { id, name: id === "user" ? "Traveler" : "Ada", role, controller: role === "user" ? "user" : "model",
    profile: { identity: "Mechanic", background: "Works at the station", personality: "Wary and patient", preferences: "Honesty", privateFacts: "Lantern Guild affiliation" },
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
