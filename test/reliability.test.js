import assert from "node:assert/strict";
import test from "node:test";
import { createAliasRegistry, decodeModelOutput, aliasOutputSchema } from "../src/aliases.js";
import { materializeTrackerOutput } from "../src/schemas.js";
import { runTracker, inspectTrackerResponse, generationParameters, normalizeConfig, recoverSetupPreview } from "../src/tracker.js";
import { normalizeTrackerDiagnostics } from "../src/diagnostics.js";
import { fixtureState, SOURCES, character, modelOutput } from "./fixtures.js";

const patch = (id, changes = [], action = "update") => ({ ...(id ? { id } : {}), action, changes: changes.map(([field, value]) => ({ field, value })) });
const output = (parts = {}) => ({ schemaVersion: 2, world: patch(null, [], "preserve"), characters: [], relationships: [], places: [], objectives: [], ...parts });
function initialOutput(sceneStatus = "in_progress") {
  return output({ world: patch(null, [["date", "October 13"], ["time", "Midnight"], ["weather", "Rain"], ["sceneStatus", sceneStatus]]),
    characters: [patch("c1", [["name", "Ada"], ["profile.identity", "Mechanic"], ["profile.personality", "Practical"], ["profile.privateFacts", "Lantern Guild"], ["visible.dressAndLayers", "Blue coat"]])] });
}
function cast() {
  const state = fixtureState(), npc = character("npc:mira", "npc"); npc.name = "Mira";
  state.characters.push(npc);
  state.relationships.push({ id: "rel:colleagues", fromId: "char:ada", toId: npc.id, publicStatus: "Colleagues", privateState: "Unknown", boundaryOrConcern: "Unknown", sourceMessageId: "card-baseline" });
  state.objectives.push({ id: "objective:signal", ownerId: npc.id, objective: "Repair the signal", status: "active", timing: "Tonight", sourceMessageId: "card-baseline" });
  return state;
}
function mock(responses, connection = { id: "default", provider: "openai", model: "test-model", is_default: true }) {
  connection = { is_default: true, ...connection };
  const requests = [], diagnostics = [];
  const api = { connections: { list: async () => [connection], get: async () => connection }, generate: { quiet: async request => {
    requests.push(structuredClone({ messages: request.messages, parameters: request.parameters, connection_id: request.connection_id }));
    const response = responses[Math.min(requests.length - 1, responses.length - 1)];
    if (typeof response === "function") return response(request);
    return structuredClone(response);
  } } };
  const run = (previous = cast()) => runTracker(api, { sources: SOURCES, previousState: previous, userText: "Ask Mira about Ada", assistantText: "Ada and Mira discuss the signal.", sourceMessageId: "a1", onDiagnostic: detail => diagnostics.push(detail) }, {}, "owner");
  return { api, requests, diagnostics, run };
}

test("preserved records restore authoritative values before copied payloads are validated", () => {
  const previous = cast(), before = structuredClone(previous);
  const proposed = output({
    world: { action: "preserve", changes: "ignored" },
    characters: [{ id: "c1", action: "preserve", name: "Wrong name", internal: { mood: "Unsupported" } }],
    relationships: [{ id: "r1", action: "preserve", fromId: "p99", toId: "new_u1" }],
    objectives: [{ id: "o1", action: "preserve", ownerId: "c99" }],
    places: [{ id: "p1", action: "preserve", description: null }],
  });
  const next = materializeTrackerOutput(decodeModelOutput(proposed, createAliasRegistry(SOURCES, previous)), previous, "a1");
  assert.deepEqual(next, previous); assert.deepEqual(previous, before);
});

test("sparse field patches retain profiles, other fields, absent entities and original provenance", () => {
  const previous = cast();
  const proposed = output({ characters: [patch("c1", [["visible.dressAndLayers", "Coat folded on bench"]])] });
  const next = materializeTrackerOutput(decodeModelOutput(proposed, createAliasRegistry(SOURCES, previous)), previous, "a1");
  assert.deepEqual(next.characters[0].profile, previous.characters[0].profile);
  assert.equal(next.characters[0].visible.dressAndLayers, "Coat folded on bench");
  assert.equal(next.characters[0].visible.position, previous.characters[0].visible.position);
  assert.equal(next.characters[0].sourceMessageId, "a1");
  assert.deepEqual(next.characters[1], previous.characters[1]); assert.deepEqual(next.relationships, previous.relationships);
});

test("minimal NPC and user declarations resolve references without invented profiles", () => {
  const previous = fixtureState(), proposed = output({
    characters: [patch("new_n1", [["name", "Mira"]]), patch("new_u1", [["name", "User"]])],
    relationships: [patch("new_r1", [["fromId", "c1"], ["toId", "new_n1"]]), patch("new_r2", [["fromId", "c1"], ["toId", "new_u1"]])],
  });
  const next = materializeTrackerOutput(decodeModelOutput(proposed, createAliasRegistry(SOURCES, previous)), previous, "a1");
  const npc = next.characters.find(entry => entry.name === "Mira"), user = next.characters.find(entry => entry.id === "user");
  assert.equal(npc.role, "npc"); assert.equal(npc.controller, "model");
  assert.ok(Object.values(npc.profile).every(value => value === "Unknown"));
  assert.equal(user.role, "user"); assert.ok(Object.values(user.internal).every(value => value === "Unknown"));
  assert.equal(next.relationships[0].toId, npc.id); assert.equal(next.relationships[1].toId, user.id);
  const bad = structuredClone(proposed); bad.characters[1].changes.push({ field: "internal.mood", value: "Happy" });
  assert.throws(() => decodeModelOutput(bad, createAliasRegistry(SOURCES, previous)), /User internal state must remain Unknown/);
});

test("all invalid endpoints and owners are reported with indexes, aliases and missing declarations", () => {
  const proposed = output({ relationships: [patch("r1", [["fromId", "c99"], ["toId", "new_u1"]])], objectives: [patch("o1", [["ownerId", "p1"]])] });
  assert.throws(() => decodeModelOutput(proposed, createAliasRegistry(SOURCES, cast())), error => {
    assert.equal(error.issues.length, 3);
    assert.deepEqual(error.issues.map(issue => issue.path), ["relationships[0].fromId", "relationships[0].toId", "objectives[0].ownerId"]);
    assert.deepEqual(error.issues.map(issue => issue.recordId), ["r1", "r1", "o1"]);
    assert.equal(error.issues[1].code, "missing_declaration");
    for (const alias of ["c99", "new_u1", "p1"]) assert.ok(error.message.includes(alias));
    return true;
  });
});

test("targeted repair fixes every rejected record and retains unrelated validated updates", async () => {
  const rejected = output({ characters: [patch("c1", [["visible.dressAndLayers", "Coat folded on bench"]])],
    relationships: [patch("r1", [["toId", "new_u1"]])], objectives: [patch("o1", [["ownerId", "p1"]])] });
  const repaired = output({ relationships: [patch("r1", [["toId", "n1"]])], objectives: [patch("o1", [["ownerId", "c1"]])] });
  const h = mock([{ content: JSON.stringify(rejected) }, { content: JSON.stringify(repaired) }]);
  const next = await h.run();
  assert.equal(h.requests.length, 2);
  const repair = h.requests[1].messages.at(-1).content;
  for (const value of ["new_u1", "p1", "relationships[0].toId", "objectives[0].ownerId", "TARGETED REPAIR"]) assert.ok(repair.includes(value), value);
  assert.equal(next.characters[0].visible.dressAndLayers, "Coat folded on bench");
  assert.equal(next.objectives[0].ownerId, "char:ada");
  assert.equal(h.diagnostics.at(-1).outcome, "repaired");
  assert.equal(h.diagnostics.at(-1).attempts[0].issues.length, 2);
});

test("failed or incomplete repairs cannot drop a rejected relationship or mutate the saved state", async () => {
  const previous = cast(), before = structuredClone(previous);
  const rejected = output({ characters: [patch("c1", [["visible.items", "A new bag"]])], relationships: [patch("r1", [["toId", "new_n2"]])] });
  const h = mock([{ content: JSON.stringify(rejected) }, { content: JSON.stringify(output()) }]);
  await assert.rejects(h.run(previous), /omitted rejected relationships record r1/);
  assert.deepEqual(previous, before); assert.equal(h.diagnostics.at(-1).outcome, "failed");
});

test("a repair that fixes only the first invalid reference still reports the remaining failure precisely", async () => {
  const rejected = output({ relationships: [patch("r1", [["fromId", "c99"], ["toId", "new_u1"]])] });
  const repair = output({ relationships: [patch("r1", [["fromId", "c1"], ["toId", "new_u1"]])] });
  const h = mock([{ content: JSON.stringify(rejected) }, { content: JSON.stringify(repair) }]);
  await assert.rejects(h.run(), /relationships\[0\]\.toId.*new_u1/);
  assert.equal(h.requests.length, 2); assert.equal(h.diagnostics.at(-1).attempts[1].issues.length, 1);
});

test("empty, malformed, wrong-type, reasoning-only and truncated responses preserve repair evidence", async () => {
  const cases = [
    [{ content: "" }, "empty"], [{ content: "", reasoning: "thinking" }, "reasoning_only"],
    [{ content: "The story continues, without JSON." }, "malformed_json"], [{ content: "[]" }, "wrong_json_type"],
    [{ content: '{"schemaVersion":2', finish_reason: "length" }, "truncated"],
    [{ content: "Cannot comply", finish_reason: "content_filter" }, "refusal"],
  ];
  for (const [response, category] of cases) {
    const h = mock([response, { content: JSON.stringify(output()), finish_reason: "stop" }]);
    await h.run();
    assert.equal(h.diagnostics.at(-1).attempts[0].category, category);
    const evidence = h.requests[1].messages.at(-2).content;
    assert.equal(evidence, response.content || "[The prior response was empty.]");
    assert.equal(h.diagnostics.at(-1).outcome, "repaired");
  }
});

test("JSON tool argument strings work and missing or ambiguous calls have distinct diagnostics", async () => {
  const h = mock([{ tool_calls: [{ name: "record_story_state", args: JSON.stringify(output()) }], finish_reason: "tool_calls" }], { id: "claude", provider: "anthropic" });
  await h.run(); assert.equal(h.requests.length, 1);
  assert.equal(inspectTrackerResponse({ tool_calls: [{ name: "other", args: {} }] }, "anthropic").category, "missing_tool");
  assert.equal(inspectTrackerResponse({ tool_calls: [{ name: "record_story_state", args: {} }, { name: "record_story_state", args: {} }] }, "anthropic").category, "ambiguous_tool");
});

test("final failures include provider, finish metadata, bounded private evidence and both attempts", async () => {
  const content = "broken ".repeat(1000), h = mock([{ content, finish_reason: "length", usage: { completion_tokens: 100 } }]);
  await assert.rejects(h.run(), error => {
    assert.match(error.message, /finish=length; contentChars=7000; toolCalls=0/);
    assert.equal(error.diagnostics.provider, "openai"); assert.equal(error.diagnostics.model, "test-model");
    assert.equal(error.diagnostics.attempts.length, 2);
    assert.equal(error.diagnostics.attempts[1].excerpt.length, 3000); return true;
  });
  assert.equal(h.requests.length, 2);
});

test("transport failures are classified without spending a state repair on a failed request", async () => {
  const h = mock([() => { throw new Error("Connection reset"); }]);
  await assert.rejects(h.run(), error => error.code === "TRACKER_GENERATION_FAILED" && /transport/.test(error.message));
  assert.equal(h.requests.length, 1); assert.equal(h.diagnostics.at(-1).attempts[0].category, "transport");
});

test("provider payloads use compact schemas, pin the resolved connection and remove inherited stops", async () => {
  const h = mock([{ content: JSON.stringify(output()) }]); await h.run();
  const request = h.requests[0], schema = request.parameters.response_format.json_schema.schema;
  assert.equal(request.connection_id, "default"); assert.equal(request.parameters.model, "test-model"); assert.deepEqual(request.parameters.stop, []);
  assert.deepEqual(schema.properties.characters.items.required, ["id", "action", "changes"]);
  const changes = schema.properties.characters.items.properties.changes.items;
  assert.ok((changes.anyOf ?? [changes]).some(branch => branch.properties.field.enum.includes("visible.dressAndLayers")));
  assert.ok(!schema.properties.characters.items.properties.profile);
  const config = normalizeConfig(), responses = generationParameters({ provider: "openai" }, config, schema, { useResponsesApi: true });
  assert.equal(responses.response_format, undefined); assert.equal(responses.text.format.type, "json_schema");
  assert.equal(responses.use_responses_api, true);
  const explicit = generationParameters({ provider: "openai" }, normalizeConfig({ outputMode: "openai-responses" }), schema);
  assert.equal(explicit.use_responses_api, true); assert.equal(explicit.response_format, undefined); assert.equal(explicit.text.format.type, "json_schema");
  const google = generationParameters({ provider: "google" }, config, schema);
  assert.equal(google.responseMimeType, "application/json"); assert.deepEqual(google.responseSchema, schema);
});

test("preset Responses selection survives tracker formatting and uses the scoped preset lookup", async () => {
  const h = mock([{ content: JSON.stringify(output()) }], { id: "openai", provider: "openai", preset_id: "preset" });
  h.api.presets = { get: async (id, userId) => { assert.equal(id, "preset"); assert.equal(userId, "owner"); return { parameters: { use_responses_api: true } }; } };
  await h.run(); assert.equal(h.requests[0].parameters.text.format.type, "json_schema");
  assert.equal(h.diagnostics.at(-1).outputMode, "openai-responses");
});

test("ungranted preset inspection is skipped and the fallback is explicit in diagnostics", async () => {
  const h = mock([{ content: JSON.stringify(output()) }], { id: "openai", provider: "openai", preset_id: "preset" });
  h.api.permissions = { has: () => false }; h.api.presets = { get: () => assert.fail("Must not call an ungranted host capability") };
  await h.run(); assert.equal(h.requests[0].parameters.use_responses_api, false);
  assert.match(h.diagnostics.at(-1).notes[0], /Presets permission/);
});

test("unsafe fields, duplicate changes and undeclared characters are not guessed during normalization", () => {
  for (const changes of [ [["__proto__.polluted", "yes"]], [["visible.items", "Bag"], ["visible.items", "Box"]] ]) {
    assert.throws(() => decodeModelOutput(output({ characters: [patch("c1", changes)] }), createAliasRegistry(SOURCES, cast())), /unsupported change field|duplicate change field/);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(normalizeTrackerDiagnostics({ attempts: [null, { issues: [null], excerpt: "a".repeat(8000) }], notes: "bad" }).attempts[0].excerpt.length, 3000);
  // The request schema can enumerate field paths, but record dependencies must
  // still be checked locally rather than trusted to provider JSON enforcement.
  const schema = aliasOutputSchema(createAliasRegistry(SOURCES, cast()), { patches: true });
  assert.equal(schema.additionalProperties, false);
  assert.throws(() => decodeModelOutput({ schemaVersion: 2 }, createAliasRegistry(SOURCES, cast())), /world must be an object/);
  const incomplete = output(); delete incomplete.characters;
  assert.throws(() => decodeModelOutput(incomplete, createAliasRegistry(SOURCES, cast())), /characters.*must be an array/);
});

test("compact provider schemas constrain status and role values rather than accepting arbitrary strings", () => {
  const schema = aliasOutputSchema(createAliasRegistry(SOURCES, cast()), { patches: true });
  const permits = (kind, field, value) => {
    const changes = (kind === "world" ? schema.properties.world : schema.properties[kind].items).properties.changes.items;
    return (changes.anyOf ?? [changes]).some(branch => branch.properties.field.enum.includes(field)
      && (!branch.properties.value.enum || branch.properties.value.enum.includes(value)));
  };
  assert.equal(permits("world", "sceneStatus", "active"), true); assert.equal(permits("world", "sceneStatus", "ended"), true);
  for (const invalid of ["Unknown", "in_progress", "narrating", "completed"]) assert.equal(permits("world", "sceneStatus", invalid), false);
  assert.equal(permits("objectives", "status", "completed"), true); assert.equal(permits("objectives", "status", "finished"), false);
  assert.equal(permits("characters", "role", "npc"), true); assert.equal(permits("characters", "role", "friend"), false);
});

test("scene status normalizes casing and absent knowledge without inventing a scene transition", () => {
  for (const [value, expected] of [[" ACTIVE ", "active"], ["Ended", "ended"], ["Unknown", "active"]]) {
    assert.equal(decodeModelOutput(initialOutput(value), createAliasRegistry(SOURCES)).world.sceneStatus, expected);
  }
  const previous = fixtureState(); previous.world.sceneStatus = "ended";
  assert.equal(decodeModelOutput(output({ world: patch(null, [["sceneStatus", "Unknown"]]) }), createAliasRegistry(SOURCES, previous)).world.sceneStatus, "ended");
});

test("world-only repair retains initial profiles AND valid date/time/weather in compact and legacy responses", async () => {
  for (const legacy of [false, true]) {
    const rejected = legacy ? modelOutput(undefined, { initialize: true }) : initialOutput();
    if (legacy) rejected.world.sceneStatus = "in_progress";
    const h = mock([{ content: JSON.stringify(rejected), finish_reason: "stop" }, { content: JSON.stringify(output({ world: patch(null, [["sceneStatus", "active"]]) })), finish_reason: "stop" }]);
    const previews = [];
    const next = await runTracker(h.api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline", onSetupPreview: preview => previews.push(preview) }, {});
    assert.equal(h.requests.length, 2); assert.equal(next.world.sceneStatus, "active"); assert.equal(next.world.date, "October 13");
    assert.equal(next.world.time, "00:00"); assert.equal(next.world.weather, "Rain"); assert.equal(next.characters[0].profile.identity, "Mechanic");
    assert.equal(next.characters[0].visible.dressAndLayers, "Blue coat");
    assert.equal(previews.length, 1); assert.deepEqual(previews[0].unavailableFields, ["world.sceneStatus"]);
    assert.match(h.requests[1].messages.at(-1).content, /expected "active" or "ended"/);
  }
});

test("the reported world.sceneStatus failure retains independently validated profiles after both attempts fail", async () => {
  const h = mock([{ content: JSON.stringify(initialOutput()), finish_reason: "stop" },
    { content: JSON.stringify(output({ world: patch(null, [["sceneStatus", "narrating"]]) })), finish_reason: "stop" }]);
  const previews = [];
  await assert.rejects(runTracker(h.api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline", onSetupPreview: preview => previews.push(preview) }, {}),
    /world\.sceneStatus contains an invalid choice "narrating"; expected "active" or "ended".*finish=stop/);
  assert.equal(h.requests.length, 2); assert.equal(previews.at(-1).state.characters[0].profile.identity, "Mechanic");
  assert.equal(previews.at(-1).state.world.date, "October 13");
  assert.deepEqual(previews.at(-1).unavailableFields, ["world.sceneStatus"]);
});

test("repairing another malformed world field also retains the remaining valid scene fields and profiles", async () => {
  const rejected = initialOutput("active"); rejected.world.changes.find(change => change.field === "time").value = " ";
  const h = mock([{ content: JSON.stringify(rejected) }, { content: JSON.stringify(output({ world: patch(null, [["time", "Midnight"]]) })) }]);
  const next = await runTracker(h.api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline" }, {});
  assert.equal(h.requests.length, 2); assert.equal(next.world.date, "October 13"); assert.equal(next.world.weather, "Rain");
  assert.equal(next.characters[0].visible.dressAndLayers, "Blue coat");
});

test("invalid exact story clocks use the existing field repair without losing other setup facts", async () => {
  for (const [field, invalid, corrected] of [["date", "2031-02-29", "2032-02-29"], ["time", "25:10", "1:10 pm"]]) {
    const rejected = initialOutput("active"); rejected.world.changes.find(change => change.field === field).value = invalid;
    const h = mock([{ content: JSON.stringify(rejected) }, { content: JSON.stringify(output({ world: patch(null, [[field, corrected]]) })) }]);
    const next = await runTracker(h.api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline" }, {});
    assert.equal(h.requests.length, 2);
    assert.equal(next.world[field], field === "date" ? "2032-02-29" : "13:10");
    assert.equal(next.world.weather, "Rain"); assert.equal(next.characters[0].profile.identity, "Mechanic");
    assert.equal(next.characters[0].visible.dressAndLayers, "Blue coat");
    assert.ok(h.requests[1].messages.at(-1).content.includes(`world.${field}`));
  }
});

test("preview recovery excludes invalid user thoughts and never invents profiles from incomplete JSON", () => {
  const proposed = initialOutput(); proposed.characters.push(patch("new_u1", [["name", "User"], ["internal.mood", "Happy"]]));
  const preview = recoverSetupPreview(JSON.stringify(proposed), SOURCES);
  assert.equal(preview.state.characters.length, 1); assert.equal(preview.state.characters[0].name, "Ada");
  assert.equal(recoverSetupPreview(JSON.stringify(proposed).slice(0, 100), SOURCES), null);
});
