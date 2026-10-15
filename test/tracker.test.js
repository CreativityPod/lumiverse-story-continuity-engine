import assert from "node:assert/strict";
import test from "node:test";
import { runTracker, generationParameters, resolveOutputMode, normalizeConfig, TRACKER_SYSTEM_PROMPT } from "../src/tracker.js";
import { SOURCES, modelOutput, fixtureState } from "./fixtures.js";

test("provider-specific structured output and bounded configuration", () => {
  const config = normalizeConfig({ maxTokens: 99999, timeoutMs: 1 });
  assert.equal(config.maxTokens, 16384); assert.equal(config.timeoutMs, 5000);
  assert.equal(resolveOutputMode({ provider: "claude" }, "auto"), "anthropic");
  assert.ok(generationParameters({ provider: "openai" }, config).response_format);
  assert.ok(generationParameters({ provider: "gemini" }, config).responseSchema);
});
test("tracker forwards user scope, repairs once and has a shared request deadline", async () => {
  const requests = [];
  const api = { connections: { get: async () => ({ provider: "anthropic" }) }, generate: { quiet: async input => { requests.push(input); return requests.length === 1 ? { content: "bad" } : { tool_calls: [{ name: "record_story_state", args: modelOutput(undefined, { initialize: true }) }] }; } } };
  const state = await runTracker(api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline" }, { connectionId: "tracker" }, "operator-user");
  assert.equal(state.characters[0].name, "Ada"); assert.equal(requests.length, 2);
  assert.equal(requests[0].userId, "operator-user"); assert.equal(requests[0].connection_id, "tracker"); assert.equal(requests[0].signal, requests[1].signal);
  assert.equal(requests[0].tools[0].name, "record_story_state");
});
test("failed repair rejects and initialization cannot omit a card character", async () => {
  let calls = 0;
  const output = modelOutput(undefined, { initialize: true }); output.characters = [];
  const api = { connections: { list: async () => [] }, generate: { quiet: async () => { calls++; return { content: JSON.stringify(output) }; } } };
  await assert.rejects(runTracker(api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline" }, {}, "user"), /Every card character/);
  assert.equal(calls, 2);
  assert.ok(TRACKER_SYSTEM_PROMPT.includes("fictional narrative clock, never wall-clock time"));
  assert.ok(TRACKER_SYSTEM_PROMPT.includes("User internal fields must all be Unknown"));
});

test("routine requests use extracted profiles and exclude raw cards while initialization retains sources", async () => {
  const sources = structuredClone(SOURCES); sources.cards[0].description += " RAW_CARD_ONLY_SENTINEL."; sources.cards[0].exampleDialogue = "EXAMPLE_ONLY_SENTINEL"; sources.selectedOpening = "OPENING_ONLY_SENTINEL";
  const previous = fixtureState(); previous.characters[0].profile.relationshipContext = "Longstanding station partnership"; previous.characters[0].profile.boundaries = "Do not open the private locker";
  const requests = [], api = { connections: { list: async () => [] }, generate: { quiet: async input => { requests.push(input); return { content: JSON.stringify(modelOutput(previous, { initialize: input.messages[1].content.startsWith("INITIALIZE") })) }; } } };
  await runTracker(api, { initialize: true, sources, sourceMessageId: "card-baseline" }, {}, "owner");
  await runTracker(api, { sources, previousState: previous, userText: "Hello", assistantText: "Ada nods.", sourceMessageId: "a1" }, {}, "owner");
  const initial = requests[0].messages[1].content, routine = requests[1].messages[1].content;
  for (const sentinel of ["RAW_CARD_ONLY_SENTINEL", "EXAMPLE_ONLY_SENTINEL", "OPENING_ONLY_SENTINEL"]) { assert.ok(initial.includes(sentinel)); assert.ok(!routine.includes(sentinel)); }
  assert.ok(routine.includes("Longstanding station partnership")); assert.ok(routine.includes("Do not open the private locker")); assert.ok(!routine.includes("STABLE CARD SOURCES"));
});

test("all provider modes receive the same bounded alias contract including profile refresh", async () => {
  const guid = "12345678-1234-4321-8765-123456789abc", loreId = "87654321-1234-4321-8765-123456789abc";
  const sources = structuredClone(SOURCES); sources.cards[0].id = guid; sources.lore = [{ id: loreId, content: "Ada is allergic to shellfish." }];
  sources.cards[0].description += ` Reference char:${guid}.`; sources.cards[0].world_book_ids = [loreId];
  const previous = fixtureState(); previous.characters[0].id = `char:${guid}`;
  const requests = [], api = { connections: { get: async id => ({ provider: id }) }, generate: { quiet: async request => {
    requests.push(structuredClone({ messages: request.messages, parameters: request.parameters, tools: request.tools }));
    return { content: JSON.stringify(modelOutput(previous, { sources, initialize: request.messages[1].content.startsWith("INITIALIZE") })) };
  } } };
  for (const provider of ["openai", "anthropic", "gemini", "plain"]) for (const variant of ["initial", "routine", "refresh"]) {
    await runTracker(api, { sources, previousState: variant === "initial" ? null : previous, initialize: variant !== "routine", refreshProfiles: variant === "refresh",
      userText: "Offer shrimp", assistantText: "Ada declines.", sourceMessageId: "a1" }, { connectionId: provider }, "owner");
    const request = requests.at(-1), all = JSON.stringify(request);
    assert.ok(!all.includes(guid)); assert.ok(!all.includes(loreId)); assert.ok(!request.messages[1].content.includes('"sourceMessageId":'));
    assert.ok(all.includes('c1')); assert.ok(all.includes('new_n1'));
    const schema = request.parameters.response_format?.json_schema.schema ?? request.parameters.responseSchema ?? request.tools?.[0].parameters;
    if (provider !== "plain") {
      assert.ok(schema.properties.characters.items.properties.id.enum.includes("c1"));
      assert.equal(schema.properties.characters.items.properties.id.enum.includes("c2"), false);
    }
    if (variant === "routine") assert.ok(request.messages[1].content.includes('"ownerId":"l1"'));
  }
  assert.equal(requests.length, 12);
});

test("a mistyped existing alias is repaired without changing its persistent identity", async () => {
  const previous = fixtureState(), requests = [];
  const api = { connections: { list: async () => [] }, generate: { quiet: async request => {
    requests.push(request); const output = modelOutput(previous);
    output.characters[0].visible.dressAndLayers = "Coat folded on bench";
    if (requests.length === 1) output.characters[0].id = "c99";
    return { content: JSON.stringify(output) };
  } } };
  const next = await runTracker(api, { sources: SOURCES, previousState: previous, userText: "Remove the coat", assistantText: "Ada removes her coat.", sourceMessageId: "a1" }, {}, "owner");
  assert.equal(requests.length, 2); assert.equal(next.characters.length, 1); assert.equal(next.characters[0].id, previous.characters[0].id);
  assert.equal(next.characters[0].visible.dressAndLayers, "Coat folded on bench"); assert.equal(next.characters[0].sourceMessageId, "a1");
});

test("unchanged unselected places no longer consume a repair or block selected updates", async () => {
  const previous = fixtureState();
  previous.places.push({ ...previous.places[0], id: "place:remote", name: "Observatory", description: "Distant hilltop", currentState: "Lens broken" });
  let calls = 0;
  const api = { connections: { list: async () => [] }, generate: { quiet: async () => {
    calls++; const output = modelOutput(previous); output.characters[0].visible.dressAndLayers = "Coat on bench";
    return { content: JSON.stringify(output) };
  } } };
  const state = await runTracker(api, { sources: SOURCES, previousState: previous, assistantText: "Ada removes her coat.", sourceMessageId: "a1" }, {}, "owner");
  assert.equal(calls, 1); assert.deepEqual(state.places, previous.places);
  assert.equal(state.characters[0].visible.dressAndLayers, "Coat on bench");
});

test("scope repair names every rejected alias across providers and preserves valid selected updates", async () => {
  for (const provider of ["openai", "anthropic", "gemini", "plain"]) {
    const previous = fixtureState();
    const ids = ["place:12345678-1234-4321-8765-123456789abc", "place:87654321-1234-4321-8765-123456789abc"];
    for (const [index, name] of ["Observatory", "Quarry"].entries()) previous.places.push({ ...previous.places[0], id: ids[index], name, description: "Distant hilltop" });
    let calls = 0;
    const api = { connections: { get: async () => ({ provider }) }, generate: { quiet: async request => {
      calls++;
      const catalog = JSON.parse(request.messages[1].content.split("\n").at(-1));
      assert.deepEqual(catalog.existing.places.map(entry => entry.canUpdate), [true, false, false]);
      const schema = request.parameters.response_format?.json_schema.schema ?? request.parameters.responseSchema ?? request.tools?.[0].parameters;
      if (schema) {
        assert.ok(schema.properties.places.items.properties.id.enum.includes("p1"));
        assert.ok(!schema.properties.places.items.properties.id.enum.includes("p2"));
      }
      const output = modelOutput(previous); output.characters[0].visible.dressAndLayers = "Coat on bench";
      if (calls === 1) for (const place of output.places.slice(1)) place.currentState = "Unsupported change";
      else {
        const repair = request.messages.at(-1).content;
        for (const term of ["p2", "p3", "Observatory", "Quarry", "Remove ALL", "canUpdate true"]) assert.ok(repair.includes(term));
        for (const id of ids) assert.ok(!JSON.stringify(request.messages).includes(id));
        output.places = output.places.slice(0, 1);
      }
      return { content: JSON.stringify(output) };
    } } };
    const state = await runTracker(api, { sources: SOURCES, previousState: previous, assistantText: "Ada removes her coat.", sourceMessageId: "a1" }, { connectionId: provider }, "owner");
    assert.equal(calls, 2); assert.deepEqual(state.places, previous.places);
    assert.equal(state.characters[0].visible.dressAndLayers, "Coat on bench");
  }
});

test("a place referred to by its saved sublocation can receive a supported update", async () => {
  const previous = fixtureState(); previous.world.location = "Platform";
  const api = { connections: { list: async () => [] }, generate: { quiet: async request => {
    assert.ok(request.messages[1].content.includes('"description":"A covered platform"'));
    const output = modelOutput(previous); output.places[0].currentState = "Side door open";
    return { content: JSON.stringify(output) };
  } } };
  const state = await runTracker(api, { sources: SOURCES, previousState: previous, assistantText: "Ada opens the side door.", sourceMessageId: "a1" }, {}, "owner");
  assert.equal(state.places[0].currentState, "Side door open"); assert.equal(state.places[0].sourceMessageId, "a1");
});
