import assert from "node:assert/strict";
import test from "node:test";
import { validateState, materializeTrackerOutput, publicTrackerSnapshot, trackerStateForLlm, remapStateSources, compactPromptState, TRACKER_OUTPUT_JSON_SCHEMA, legacyTrackerState } from "../src/schemas.js";
import { fixtureState, character, outputState } from "./fixtures.js";

test("state validates and the observable projection omits all private sections", () => {
  const state = fixtureState();
  assert.deepEqual(validateState(state), state);
  const publicState = publicTrackerSnapshot(state), text = JSON.stringify(publicState);
  for (const secret of ["Lantern Guild", "Hidden tunnel", "Repair the signal", "sourceMessageId", "privateFacts", "internal", "profile"]) assert.ok(!text.includes(secret));
  assert.equal(publicState.characters[0].visible.dressAndLayers, "Blue coat");
});
test("provider actions preserve unchanged canonical provenance and assign updated sources locally", () => {
  const prior = fixtureState(), output = trackerStateForLlm(prior);
  output.characters[0].visible.dressAndLayers = "No coat; white shirt";
  output.characters[0].action = "update";
  const state = materializeTrackerOutput(output, prior, "a1");
  assert.equal(state.world.sourceMessageId, "card-baseline");
  assert.equal(state.characters[0].sourceMessageId, "a1");
  assert.equal(state.characters[0].visible.dressAndLayers, "No coat; white shirt");
  assert.equal(materializeTrackerOutput(outputState(prior), prior, "a2").characters[0].sourceMessageId, "card-baseline");
});
test("omitted old characters and places remain persistent", () => {
  const prior = fixtureState(), output = trackerStateForLlm(prior);
  output.characters = []; output.places = [];
  assert.deepEqual(materializeTrackerOutput(output, prior, "a1"), prior);
});
test("validation rejects malformed fields, lists, duplicate ids and spoofed provenance", () => {
  const malformed = outputState(); malformed.characters[0].visible.physicalState = 42;
  assert.throws(() => materializeTrackerOutput(malformed, null, "a1"), /must be text/);
  const duplicate = outputState(); duplicate.characters.push(duplicate.characters[0]);
  assert.throws(() => materializeTrackerOutput(duplicate, null, "a1"), /duplicate/);
  const spoof = outputState(); spoof.characters[0].sourceMessageId = "other-branch";
  assert.throws(() => materializeTrackerOutput(spoof, null, "a1"), /unexpected fields/);
  assert.throws(() => validateState(fixtureState(), { allowedSourceMessageIds: ["a1"] }), /provenance/);
  const markup = fixtureState(); markup.characters[0].visible.items = "<!--hidden-->";
  assert.throws(() => validateState(markup), /invalid text/);
});
test("new entities cannot preserve and existing controller roles cannot change", () => {
  const output = outputState(); output.characters[0].action = "preserve";
  assert.throws(() => materializeTrackerOutput(output, null, "a1"), /new entity/);
  const prior = fixtureState(), modified = trackerStateForLlm(prior);
  modified.characters[0].controller = "user"; modified.characters[0].role = "user";
  assert.throws(() => materializeTrackerOutput(modified, prior, "a1"), /cannot be changed/);
});
test("user thoughts cannot be stored and references must name established characters", () => {
  const state = fixtureState(), user = character("user", "user"); state.characters.push(user);
  assert.throws(() => validateState(state), /internal state/);
  for (const key of Object.keys(user.internal)) user.internal[key] = "Unknown";
  assert.equal(validateState(state).characters[1].controller, "user");
  state.relationships.push({ id: "rel:ada-ghost", fromId: "char:ada", toId: "npc:ghost", publicStatus: "Unknown", privateState: "Unknown", boundaryOrConcern: "Unknown", sourceMessageId: "card-baseline" });
  assert.throws(() => validateState(state), /references/);
});
test("fork and portable state remap every source and reject incomplete maps", () => {
  const state = fixtureState(); state.world.sourceMessageId = "a1";
  assert.equal(remapStateSources(state, new Map([["a1", "f1"]])).world.sourceMessageId, "f1");
  assert.throws(() => remapStateSources(state, new Map()), /Incomplete/);
  const portable = remapStateSources(state, new Map(), "initial-setup");
  assert.equal(portable.characters[0].sourceMessageId, "initial-setup");
});
test("compact prompt retains private continuity but omits defaults and provenance", () => {
  const text = JSON.stringify(compactPromptState(fixtureState()));
  assert.ok(text.includes("Lantern Guild")); assert.ok(!text.includes("sourceMessageId")); assert.ok(!text.includes('"Unknown"'));
  assert.ok(!JSON.stringify(TRACKER_OUTPUT_JSON_SCHEMA).includes('"pattern"'));
});

test("legacy v1 state migrates conservatively, preserving provenance and existing profiles", () => {
  const current = fixtureState(), legacy = legacyTrackerState(current);
  assert.equal(legacy.schemaVersion, 1); assert.ok(!Object.hasOwn(legacy.characters[0].profile, "boundaries"));
  const before = JSON.stringify(legacy), upgraded = validateState(legacy);
  assert.equal(upgraded.schemaVersion, 2); assert.equal(upgraded.characters[0].profile.boundaries, "Unknown"); assert.equal(upgraded.characters[0].profile.relationshipContext, "Unknown");
  assert.equal(upgraded.characters[0].profile.privateFacts, current.characters[0].profile.privateFacts); assert.equal(upgraded.characters[0].sourceMessageId, "card-baseline"); assert.equal(JSON.stringify(legacy), before);
  assert.equal(publicTrackerSnapshot(upgraded).characters[0].profile, undefined);
});
