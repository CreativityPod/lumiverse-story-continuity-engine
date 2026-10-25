import test from "node:test";
import assert from "node:assert/strict";
import { runTracker } from "../src/tracker.js";
import { createAliasRegistry, decodeModelOutput } from "../src/aliases.js";
import { activePartialUpdates, acceptedTrackerUpdates } from "../src/partial.js";
import { validateState } from "../src/schemas.js";
import { fixtureState, character, SOURCES } from "./fixtures.js";

const patch = (id, changes = [], action = "update") => ({ ...(id ? { id } : {}), action, changes: changes.map(([field, value]) => ({ field, value })) });
const output = (parts = {}) => ({ schemaVersion: 3, world: patch(null, [], "preserve"), characters: [], relationships: [], places: [], objectives: [], ...parts });
const recap = "They discussed an earlier task and reviewed each completed step. ".repeat(40).slice(0, 2190);
const summary = "Ada trusts Mira's practical judgment but remains guarded about confidential guild matters. Their agreement to keep the repair details private remains in force.";
function cast() {
  const state = fixtureState(), npc = character("npc:mira", "npc"); npc.name = "Mira"; state.characters.push(npc);
  state.relationships.push({ id: "rel:colleagues", fromId: "char:ada", toId: npc.id, publicStatus: "Colleagues", privateState: "Cautious trust", boundaryOrConcern: "Keep guild matters private", sourceMessageId: "card-baseline" });
  return state;
}
function harness(responses) {
  const requests = [], partials = [], receipts = [], diagnostics = [];
  const api = { connections: { list: async () => [] }, generate: { quiet: async request => {
    requests.push(structuredClone(request.messages));
    return { content: JSON.stringify(responses[Math.min(requests.length - 1, responses.length - 1)]) };
  } } };
  return { requests, partials, receipts, diagnostics, run: (previousState = cast(), extra = {}) => runTracker(api, { sources: SOURCES, previousState,
    userText: "Ask Mira about the repair", assistantText: "Ada and Mira discuss the signal repair.", sourceMessageId: "a1",
    onPartial: value => partials.push(value), onAccepted: value => receipts.push(value), onDiagnostic: value => diagnostics.push(value), ...extra }, {}) };
}
const issue = (id = "rel:colleagues", fields = ["privateState"]) => ({ kind: "relationships", id, alias: "r1", path: "relationships[0].privateState", code: "invalid_text", fields });
const partial = (sourceMessageId, issues = [issue()]) => ({ sourceMessageId, issues });
const receipt = (id = "rel:colleagues", fields = ["privateState"]) => [{ kind: "relationships", id, fields }];

test("validation identifies exact length, empty text and reserved markup without changing the 1600 limit", () => {
  const registry = createAliasRegistry(SOURCES, cast());
  for (const [value, reason] of [[recap, /2190 characters exceeds the 1600-character limit/], ["   ", /empty after trimming/], ["<!--hidden-->", /reserved HTML comment/]]) {
    assert.throws(() => decodeModelOutput(output({ relationships: [patch("r1", [["privateState", value]])] }), registry), error => {
      assert.equal(error.issues[0].code, "invalid_text"); assert.match(error.issues[0].message, reason); return true;
    });
  }
  assert.doesNotThrow(() => decodeModelOutput(output({ relationships: [patch("r1", [["privateState", "x".repeat(1600)]])] }), registry));
  assert.throws(() => decodeModelOutput(output({ relationships: [patch("r1", [["privateState", "x".repeat(1601)]])] }), registry), /1601 characters/);
});

test("overlong relationship repair requests a current-state summary and retains independent updates", async () => {
  const first = output({ characters: [patch("c1", [["profile.age", "32"]])], relationships: [patch("r1", [["privateState", recap]])] });
  const repaired = output({ relationships: [patch("r1", [["privateState", summary]])] });
  const h = harness([first, repaired]), state = await h.run();
  assert.equal(h.requests.length, 2); assert.equal(state.relationships[0].privateState, summary); assert.equal(state.characters[0].profile.age, "32");
  const instruction = h.requests[0][0].content, repair = h.requests[1].at(-1).content;
  assert.match(instruction, /privateState is a concise summary of current private relationship dynamics/);
  assert.match(instruction, /never invent the user's unspoken feelings or assume reciprocity/);
  assert.match(instruction, /boundaryOrConcern holds relationship-specific limits/);
  assert.match(repair, /2190 characters exceeds the 1600-character limit/); assert.match(repair, /without a chronological event recap/);
  assert.match(repair, /still-active commitments, boundaries and uncertainty/);
  assert.equal(h.partials.length, 0); assert.ok(h.receipts[0].some(entry => entry.id === "rel:colleagues" && entry.fields.includes("privateState")));
  assert.equal(state.relationships[0].boundaryOrConcern, "Keep guild matters private");
});

test("unsuccessful summary repair shortens prose with a persistent warning and no false completion receipt", async () => {
  const proposed = output({ characters: [patch("c1", [["profile.age", "32"]])], relationships: [patch("r1", [["privateState", recap], ["publicStatus", "Friends"]])] });
  const before = structuredClone(proposed), previous = cast(), h = harness([proposed]), state = await h.run(previous);
  assert.ok(state.relationships[0].privateState.length <= 1600); assert.match(state.relationships[0].privateState, / …$/);
  assert.ok(state.relationships[0].privateState.startsWith("They discussed")); assert.equal(state.relationships[0].publicStatus, "Friends");
  assert.equal(h.partials[0].issues[0].code, "truncated_text"); assert.equal(h.partials[0].issues[0].originalLength, 2190);
  assert.deepEqual(h.receipts[0].find(entry => entry.id === "rel:colleagues").fields, ["publicStatus"]);
  assert.equal(state.characters[0].profile.age, "32"); assert.deepEqual(validateState(state), state); assert.deepEqual(proposed, before);
  const retry = harness([output({ relationships: [patch("r1", [["privateState", summary]])] })]);
  const corrected = await retry.run(state, { pendingUpdates: h.partials });
  assert.match(retry.requests[0][1].content, /PENDING TRACKING FIELDS/); assert.match(retry.requests[0][1].content, /"alias":"r1"/);
  assert.ok(!retry.requests[0][1].content.includes("rel:colleagues")); assert.equal(corrected.relationships[0].privateState, summary);
});

test("shortening is limited to plain relationship/scene summaries and preserves other validation guards", async () => {
  const h = harness([output({ world: patch(null, [["immediateContext", recap]]), characters: [patch("c1", [["visible.items", "x".repeat(1601)]])],
    relationships: [patch("r1", [["boundaryOrConcern", "x".repeat(1601)]])] })]);
  const previous = cast(), state = await h.run(previous);
  assert.ok(state.world.immediateContext.length <= 1600); assert.ok(h.partials[0].issues.some(entry => entry.code === "truncated_text" && entry.kind === "world"));
  assert.equal(state.characters[0].visible.items, previous.characters[0].visible.items);
  assert.equal(state.relationships[0].boundaryOrConcern, previous.relationships[0].boundaryOrConcern);
  const unsafe = harness([output({ relationships: [patch("r1", [["privateState", recap + "<!--hidden-->"]])] })]);
  const protectedState = await unsafe.run(previous); assert.equal(protectedState.relationships[0].privateState, "Cautious trust");
  assert.equal(unsafe.partials[0].issues[0].code, "invalid_text");
});

test("active warnings coalesce by canonical identity and clear only on valid replacement of that field", () => {
  const state = cast(), other = { ...structuredClone(state.relationships[0]), id: "rel:other" }; state.relationships.push(other);
  const store = { baseline: state, checkpoints: { a1: { state, partial: partial("a1"), acceptedUpdates: [] } } };
  store.checkpoints.a2 = { state, partial: partial("a2"), acceptedUpdates: [] };
  assert.equal(activePartialUpdates(store).length, 1); assert.equal(activePartialUpdates(store)[0].sourceMessageId, "a2");
  store.checkpoints.a3 = { state, partial: null, acceptedUpdates: receipt("rel:other") };
  store.checkpoints.a4 = { state, partial: null, acceptedUpdates: receipt("rel:colleagues", ["publicStatus"]) };
  assert.equal(activePartialUpdates(store).length, 1);
  // An explicit valid replacement may equal the old value; a preserve/no-op cannot count as this receipt.
  store.checkpoints.a5 = { state, partial: null, acceptedUpdates: receipt() };
  assert.equal(activePartialUpdates(store).length, 0);
  assert.ok(store.checkpoints.a1.partial); assert.ok(store.checkpoints.a2.partial);
  assert.equal(activePartialUpdates({ ...store, checkpoints: { a1: store.checkpoints.a1 } })[0].sourceMessageId, "a1");
  const registry = createAliasRegistry(SOURCES, state);
  assert.deepEqual(acceptedTrackerUpdates(output({ relationships: [patch("r1", [["privateState", "Ignored"]], "preserve")] }), registry, state), []);
});

test("legacy state differences resolve current warnings without rewriting past checkpoints or guessing unidentified targets", () => {
  const state = cast(), changed = structuredClone(state); changed.relationships[0].privateState = summary;
  const store = { baseline: state, baselinePartial: partial("card-baseline"), checkpoints: { a1: { state: changed, partial: null } } };
  assert.equal(activePartialUpdates(store).length, 0);
  store.checkpoints.a2 = { state: changed, partial: partial("a2", [{ ...issue(""), alias: "new_r1", fields: null }]), acceptedUpdates: [] };
  store.checkpoints.a3 = { state: changed, partial: null, acceptedUpdates: receipt() };
  assert.equal(activePartialUpdates(store).length, 1); assert.equal(activePartialUpdates(store)[0].sourceMessageId, "a2");
  assert.ok(store.baselinePartial);
});

test("pending guidance and complete-update receipts cannot expand tracking scope to absent actors", async () => {
  const state = cast(), remote = character("npc:remote", "npc"); remote.name = "Rae"; remote.visible.position = "Observatory"; state.characters.push(remote);
  state.relationships.push({ ...structuredClone(state.relationships[0]), id: "rel:remote", toId: remote.id });
  const h = harness([output()]);
  await h.run(state, { pendingUpdates: [partial("a0", [issue(), { ...issue("rel:remote"), alias: "r2" }])] });
  const pending = JSON.parse(h.requests[0][1].content.split("PENDING TRACKING FIELDS\n")[1].split("\n")[0]);
  assert.deepEqual(pending.map(target => target.alias), ["r1"]);
  const registry = createAliasRegistry(SOURCES, state), scope = { allowedUpdateIds: { relationships: new Set(["rel:colleagues"]) } };
  const outside = output({ relationships: [patch("r2", [["privateState", state.relationships[1].privateState]])] });
  assert.deepEqual(acceptedTrackerUpdates(outside, registry, state, scope), []);
});
