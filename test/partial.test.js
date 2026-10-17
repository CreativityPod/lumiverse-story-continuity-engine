import test from "node:test";
import assert from "node:assert/strict";
import { runTracker } from "../src/tracker.js";
import { createAliasRegistry } from "../src/aliases.js";
import { recoverPartialTrackerOutput, scopePartialRetry } from "../src/partial.js";
import { validateState } from "../src/schemas.js";
import { fixtureState, character, SOURCES, modelOutput } from "./fixtures.js";

const patch = (id, changes = [], action = "update") => ({ ...(id ? { id } : {}), action, changes: changes.map(([field, value]) => ({ field, value })) });
const output = (parts = {}) => ({ schemaVersion: 3, world: patch(null, [], "preserve"), characters: [], relationships: [], places: [], objectives: [], ...parts });
function cast() {
  const state = fixtureState(), npc = character("npc:mira", "npc"); npc.name = "Mira"; state.characters.push(npc);
  state.relationships.push({ id: "rel:colleagues", fromId: "char:ada", toId: npc.id, publicStatus: "Colleagues", privateState: "Cautious trust", boundaryOrConcern: "Unknown", sourceMessageId: "card-baseline" });
  return state;
}
function harness(responses) {
  const diagnostics = [], partials = [], requests = [];
  const api = { connections: { list: async () => [] }, generate: { quiet: async request => {
    requests.push(request); const value = responses[Math.min(requests.length - 1, responses.length - 1)];
    if (typeof value === "function") return value(request);
    return { content: typeof value === "string" ? value : JSON.stringify(value) };
  } } };
  return { diagnostics, partials, requests,
    run: (previousState = cast(), extra = {}) => runTracker(api, { sources: SOURCES, previousState, userText: "Talk to Mira", assistantText: "Ada and Mira talk.",
      sourceMessageId: "a1", onPartial: detail => partials.push(detail), onDiagnostic: detail => diagnostics.push(detail), ...extra }, {}) };
}

test("invalid relationship prose cannot discard valid profile, outfit, clock or other relationship fields", async () => {
  for (const bad of ["", "x".repeat(1601), "<!--invalid-->"]) {
    const previous = cast(), before = structuredClone(previous);
    const proposed = output({ world: patch(null, [["time", "21:05"]]), characters: [patch("c1", [["profile.age", "Early thirties"], ["visible.dressAndLayers", "White shirt; coat on bench"]])],
      relationships: [patch("r1", [["privateState", bad], ["publicStatus", "Friends"]])] });
    const h = harness([proposed]); const next = await h.run(previous);
    assert.equal(next.characters[0].profile.age, "Early thirties"); assert.equal(next.characters[0].visible.dressAndLayers, "White shirt; coat on bench");
    assert.equal(next.world.time, "21:05"); assert.equal(next.relationships[0].publicStatus, "Friends"); assert.equal(next.relationships[0].privateState, "Cautious trust");
    assert.equal(h.requests.length, 2); assert.equal(h.diagnostics.at(-1).outcome, "partial");
    assert.deepEqual(h.partials[0].issues[0].fields, ["privateState"]); assert.equal(h.partials[0].issues[0].id, "rel:colleagues");
    assert.deepEqual(validateState(next), next); assert.deepEqual(previous, before);
  }
});

test("a broken or unavailable repair still preserves the first usable candidate", async () => {
  const first = output({ characters: [patch("c1", [["profile.gender", "Woman"]])], relationships: [patch("r1", [["privateState", ""]])] });
  for (const repair of ["invalid JSON", () => { throw new Error("connection lost"); }]) {
    const h = harness([first, repair]), next = await h.run();
    assert.equal(next.characters[0].profile.gender, "Woman"); assert.equal(next.relationships[0].privateState, "Cautious trust");
    assert.equal(h.diagnostics.at(-1).outcome, "partial");
  }
  const h = harness(["invalid JSON"]); await assert.rejects(h.run(), /rejected after one repair/);
});

test("invalid patch value types and duplicate fields preserve other changes in the same record", async () => {
  for (const changes of [[["profile.age", 32]], [["profile.age", "32"], ["profile.age", "200"]]]) {
    const proposed = output({ characters: [patch("c1", [...changes, ["profile.gender", "Woman"], ["visible.dressAndLayers", "White shirt"]])] });
    const h = harness([proposed]), next = await h.run();
    assert.equal(next.characters[0].profile.age, "Unknown"); assert.equal(next.characters[0].profile.gender, "Woman");
    assert.equal(next.characters[0].visible.dressAndLayers, "White shirt");
    assert.deepEqual(h.partials[0].issues[0].fields, ["profile.age"]);
  }
});

test("valid changes in an incomplete repair are merged with the original accepted components", async () => {
  const first = output({ world: patch(null, [["sceneStatus", "bad"]]), characters: [patch("c1", [["profile.age", "Adult"]])], relationships: [patch("r1", [["privateState", ""]])] });
  const repair = output({ world: patch(null, [["sceneStatus", "ended"]]) });
  const h = harness([first, repair]), next = await h.run();
  assert.equal(next.world.sceneStatus, "ended"); assert.equal(next.characters[0].profile.age, "Adult"); assert.equal(next.relationships[0].privateState, "Cautious trust");
  assert.equal(h.diagnostics.at(-1).outcome, "partial");
});

test("clock rollovers and physical transfers are retained as coupled groups", async () => {
  const previous = cast(); previous.world.date = "2031-12-31"; previous.world.time = "23:50";
  previous.characters[0].visible.items = "Unique brass key"; previous.characters[1].visible.items = "No key";
  const proposed = output({ world: patch(null, [["date", "2032-02-30"], ["time", "00:10"]]),
    characters: [patch("c1", [["visible.items", "No key"], ["profile.age", "32"]]), patch("n1", [["visible.items", ""]])] });
  const h = harness([proposed]), next = await h.run(previous);
  assert.equal(next.world.date, previous.world.date); assert.equal(next.world.time, previous.world.time);
  assert.equal(next.characters[0].visible.items, "Unique brass key"); assert.equal(next.characters[1].visible.items, "No key");
  assert.equal(next.characters[0].profile.age, "32");
  const registry = createAliasRegistry(SOURCES, next);
  const retry = scopePartialRetry(output({ world: patch(null, [["time", "00:10"]]), characters: [patch("c1", [["visible.items", "No key"]])] }), h.partials[0], registry);
  assert.ok(retry.pendingIssues.length); assert.equal(retry.output.world.changes.length, 0);
  assert.equal(retry.output.characters[0].changes.length, 0);
});

test("invalid new declarations hold dependent relationships/objectives without inventing identities", async () => {
  const proposed = output({ characters: [patch("c1", [["profile.age", "Adult"]]), patch("new_n1", [["name", ""]])],
    relationships: [patch("new_r1", [["fromId", "c1"], ["toId", "new_n1"], ["publicStatus", "Colleagues"]])],
    objectives: [patch("new_o1", [["ownerId", "new_n1"], ["objective", "Repair signal"]])] });
  const h = harness([proposed]), next = await h.run();
  assert.equal(next.characters.length, 2); assert.equal(next.characters[0].profile.age, "Adult");
  assert.equal(next.relationships.length, 1); assert.equal(next.objectives.length, 0);
  assert.ok(h.partials[0].issues.some(issue => issue.kind === "relationships"));
  assert.ok(h.partials[0].issues.some(issue => issue.kind === "objectives"));
});

test("partial corrections cannot rerun already accepted profile/outfit/time changes", async () => {
  const first = output({ characters: [patch("c1", [["profile.age", "Early thirties"], ["visible.dressAndLayers", "Coat on bench"]])], relationships: [patch("r1", [["privateState", ""]])] });
  const initial = harness([first]), saved = await initial.run();
  const proposed = output({ world: patch(null, [["time", "12:00"]]), characters: [patch("c1", [["profile.age", "99"], ["visible.dressAndLayers", "Wrong coat"]])],
    relationships: [patch("r1", [["privateState", "Comfortable trust"]])] });
  const retry = harness([proposed]), corrected = await retry.run(saved, { retryPartial: initial.partials[0] });
  assert.equal(corrected.characters[0].profile.age, "Early thirties"); assert.equal(corrected.characters[0].visible.dressAndLayers, "Coat on bench");
  assert.equal(corrected.world.time, saved.world.time); assert.equal(corrected.relationships[0].privateState, "Comfortable trust"); assert.equal(retry.partials.length, 0);
  const omitted = harness([output()]); await omitted.run(saved, { retryPartial: initial.partials[0] });
  assert.equal(omitted.diagnostics.at(-1).outcome, "partial"); assert.ok(omitted.partials[0].issues.length);
});

test("new records surviving a field failure retain canonical identities for retry", async () => {
  const proposed = output({ relationships: [patch("new_r1", [["fromId", "c1"], ["toId", "n1"], ["privateState", ""]])] });
  const h = harness([proposed]), next = await h.run();
  assert.equal(next.relationships.length, 2); const target = h.partials[0].issues.find(issue => issue.alias === "new_r1");
  assert.equal(target.id, next.relationships[1].id);
  const retry = harness([output({ relationships: [patch("r2", [["privateState", "Wary curiosity"]])] })]);
  const corrected = await retry.run(next, { retryPartial: h.partials[0] });
  assert.equal(corrected.relationships.length, 2); assert.equal(corrected.relationships[1].privateState, "Wary curiosity");
  assert.ok(!retry.requests[0].messages[1].content.includes(target.id));
  assert.match(retry.requests[0].messages[1].content, /"alias":"r2"/);
});

test("scope violations and ambiguous aliases cannot overwrite absent actors or user agency", () => {
  const previous = cast(), registry = createAliasRegistry(SOURCES, previous);
  const scope = { allowedUpdateIds: { characters: new Set(["char:ada"]), relationships: new Set(), places: new Set(), objectives: new Set() } };
  const result = recoverPartialTrackerOutput(output({ world: patch(null, [["weather", "Overcast"]]), characters: [patch("n1", [["profile.age", "200"]])] }), registry, { ...scope, sourceMessageId: "a1" });
  assert.equal(result.state.world.weather, "Overcast"); assert.equal(result.state.characters[1].profile.age, "Unknown");
  const duplicate = recoverPartialTrackerOutput(output({ characters: [patch("c1", [["profile.age", "32"]]), patch(" c1 ", [["profile.age", "200"]])] }), registry, { sourceMessageId: "a1" });
  assert.equal(duplicate.state.characters[0].profile.age, "Unknown");
  const user = character("user", "user"); for (const key of Object.keys(user.internal)) user.internal[key] = "Unknown";
  previous.characters.push(user);
  const protectedUser = recoverPartialTrackerOutput(output({ world: patch(null, [["weather", "Overcast"]]),
    characters: [patch("u1", [["internal.intent", "Confess a secret"]])] }), createAliasRegistry(SOURCES, previous), { sourceMessageId: "a1" });
  assert.equal(protectedUser.state.world.weather, "Overcast"); assert.equal(protectedUser.state.characters[2].internal.intent, "Unknown");
});
