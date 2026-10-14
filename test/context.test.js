import assert from "node:assert/strict";
import test from "node:test";
import { selectRelevantState, buildRoleplayContext, lookupSourceReferences, buildRoutineTrackerContext, SOURCE_REFERENCE_CHARS, ROLEPLAY_CONTEXT_CHARS } from "../src/context.js";
import { fixtureState, character, SOURCES } from "./fixtures.js";
import { materializeTrackerOutput, trackerStateForLlm } from "../src/schemas.js";

function extendedState() {
  const state = fixtureState();
  const mira = character("npc:mira", "npc"); mira.name = "Mira"; mira.visible.position = "Northern observatory"; mira.profile.privateFacts = "REMOTE_SECRET";
  state.characters.push(mira);
  state.places.push({ id: "place:observatory", name: "Observatory", description: "Distant hilltop", currentState: "Lens broken", connections: "Hill trail", privateFacts: "REMOTE_PLACE_SECRET", sourceMessageId: "card-baseline" });
  state.relationships.push({ id: "rel:ada-mira", fromId: "char:ada", toId: "npc:mira", publicStatus: "Old friends", privateState: "Unresolved debt", boundaryOrConcern: "Keep the telescope private", sourceMessageId: "card-baseline" });
  return state;
}

test("routine relevance omits absent NPCs and places, then restores their saved facts when mentioned", () => {
  const state = extendedState(), before = JSON.stringify(state);
  const local = selectRelevantState(state, "Hello Ada."); assert.deepEqual(local.characters.map(char => char.id), ["char:ada"]); assert.deepEqual(local.places.map(place => place.id), ["place:station"]);
  const retrieved = selectRelevantState(state, "Call Mira about the Observatory.");
  assert.equal(retrieved.characters[0].id, "char:ada"); assert.equal(retrieved.characters[1].profile.privateFacts, "REMOTE_SECRET"); assert.equal(retrieved.places[1].currentState, "Lens broken"); assert.equal(retrieved.relationships.length, 1);
  assert.equal(JSON.stringify(state), before);
});
test("same-location NPCs, user state and an explicitly focused group member receive context", () => {
  const state = extendedState(); state.characters[1].visible.position = "Station platform";
  const user = character("user", "user"); for (const field of Object.keys(user.internal)) user.internal[field] = "Unknown"; state.characters.push(user);
  assert.equal(selectRelevantState(state, "Continue").characters.length, 3);
  state.characters[1].role = "main";
  assert.equal(selectRelevantState(state, "Continue", { focusCharacterId: "npc:mira" }).characters[0].id, "npc:mira");
});
test("roleplay snapshot is bounded, flags omitted facts and never truncates or rewrites saved values", () => {
  const state = extendedState();
  for (const section of [state.characters[0].profile, state.characters[0].appearance, state.characters[0].visible, state.characters[0].internal]) for (const key of Object.keys(section)) section[key] = key.repeat(Math.floor(1500 / key.length));
  const before = JSON.stringify(state), projection = buildRoleplayContext(state, "Continue", { maxChars: 5000 });
  assert.ok(JSON.stringify(projection).length <= 5000); assert.equal(projection.projection.omittedFields, true); assert.equal(projection.projection.omittedCharacters, 1);
  assert.equal(JSON.stringify(state), before);
  for (const section of ["profile", "appearance", "visible", "internal"]) for (const [key, value] of Object.entries(projection.characters[0][section] ?? {})) assert.equal(value, state.characters[0][section][key]);
  assert.ok(JSON.stringify(buildRoleplayContext(state)).length <= ROLEPLAY_CONTEXT_CHARS);
});
test("targeted references retrieve an omitted allergy without resending guidance, examples or the opening", () => {
  const sources = structuredClone(SOURCES);
  sources.cards[0].description = "Ada is allergic to shellfish. RAW_UNRELATED_SOURCE_MARKER: she studied distant constellations.";
  sources.cards[0].exampleDialogue = "ExampleOnly: Ada loves shrimp.";
  sources.cards[0].creatorNotes = "GUIDANCE_ONLY says shrimp.";
  sources.selectedOpening = "OLD_OPENING says shrimp.";
  const refs = lookupSourceReferences(sources, fixtureState(), "Offer some shrimp for dinner.");
  assert.ok(refs.some(ref => ref.excerpt.includes("allergic to shellfish")));
  for (const absent of ["RAW_UNRELATED_SOURCE_MARKER", "ExampleOnly", "GUIDANCE_ONLY", "OLD_OPENING"]) assert.ok(!JSON.stringify(refs).includes(absent));
  assert.ok(JSON.stringify(refs).length <= SOURCE_REFERENCE_CHARS);
  assert.deepEqual(lookupSourceReferences(sources, fixtureState(), "Hello."), []);
});
test("known allergy needs no source lookup and another NPC's allergy cannot mask a missing main-character fact", () => {
  const sources = structuredClone(SOURCES); sources.cards[0].description = "Ada is allergic to shellfish.";
  const state = extendedState(); state.characters[1].profile.privateFacts = "Ada is allergic to shellfish.";
  assert.ok(lookupSourceReferences(sources, state, "Shrimp for dinner").length > 0);
  state.characters[0].profile.privateFacts = "Ada is allergic to shellfish.";
  assert.deepEqual(lookupSourceReferences(sources, state, "Shrimp for dinner"), []);
});
test("long source paragraphs yield bounded, explicitly partial reference windows", () => {
  const sources = structuredClone(SOURCES); sources.cards[0].description = `${"Unrelated detail ".repeat(300)}Ada is allergic to shellfish. ${"Other background ".repeat(300)}`;
  const refs = lookupSourceReferences(sources, fixtureState(), "Shrimp for dinner");
  assert.ok(refs.some(ref => ref.excerpt.includes("shellfish"))); assert.ok(refs.some(ref => ref.partial)); assert.ok(JSON.stringify(refs).length <= SOURCE_REFERENCE_CHARS);
});
test("merely mentioning a known actor does not repeatedly retrieve their unextracted biography", () => {
  const sources = structuredClone(SOURCES); sources.cards[0].description = "Ada inherited an obscure collection of meteorites in childhood.";
  assert.deepEqual(lookupSourceReferences(sources, fixtureState(), "Ada nods. Hello Ada."), []);
});
test("a scene's topic does not pull unrelated absent card characters back into the tracker", () => {
  const state = extendedState(); state.characters[1].id = "char:mira"; state.characters[1].role = "main"; state.relationships[0].toId = "char:mira";
  const sources = structuredClone(SOURCES); sources.cards.push({ id: "mira", name: "Mira", description: "Mira is allergic to shrimp." });
  const context = buildRoutineTrackerContext({ sources, previousState: state, userText: "Offer Ada dinner", assistantText: "Ada considers a meal." });
  assert.ok(!context.references.some(ref => ref.ownerId === "char:mira")); assert.ok(!context.state.characters.some(char => char.id === "char:mira"));
});
test("focused tracker updates merge into full storage and cannot overwrite omitted entities", () => {
  const state = extendedState(), context = buildRoutineTrackerContext({ previousState: state, sources: SOURCES, userText: "Hello", assistantText: "Ada replies." });
  assert.ok(!JSON.stringify(context.state).includes("REMOTE_SECRET")); assert.equal(context.identities.characters.length, 2);
  const output = context.state; output.characters[0].visible.dressAndLayers = "Coat folded on bench"; output.characters[0].action = "update";
  const next = materializeTrackerOutput(output, state, "a1", context);
  assert.equal(next.characters[0].visible.dressAndLayers, "Coat folded on bench"); assert.equal(next.characters[1].profile.privateFacts, "REMOTE_SECRET"); assert.equal(next.places[1].currentState, "Lens broken");
  const invalid = trackerStateForLlm(state); invalid.characters[1].action = "update"; invalid.characters[1].visible.physicalState = "Injured off-screen";
  assert.throws(() => materializeTrackerOutput(invalid, state, "a2", context), /omitted characters/);
});
test("large saved source and cast fixtures produce substantially smaller routine context without losing storage", () => {
  const state = extendedState(), sources = structuredClone(SOURCES);
  sources.cards[0].description += ` ${"An unrelated historical detail. ".repeat(500)}`;
  for (let index = 0; index < 10; index++) {
    const char = character(`npc:remote-${index}`, "npc"); char.name = `Remote${index}`; char.visible.position = "Other town"; char.profile.privateFacts = `UNRELATED_PRIVATE_DETAIL_${index} ${"Private history. ".repeat(25)}`; state.characters.push(char);
  }
  const before = JSON.stringify(state), oldContext = JSON.stringify(sources) + JSON.stringify(trackerStateForLlm(state));
  const context = buildRoutineTrackerContext({ sources, previousState: state, userText: "Hello", assistantText: "Ada nods." });
  const newContext = JSON.stringify({ state: context.state, references: context.references, identities: context.identities });
  assert.ok(newContext.length < oldContext.length / 2);
  const roleplay = JSON.stringify(buildRoleplayContext(state, "Hello")); assert.ok(!roleplay.includes("UNRELATED_PRIVATE_DETAIL")); assert.ok(!roleplay.includes("REMOTE_SECRET")); assert.equal(JSON.stringify(state), before);
});
