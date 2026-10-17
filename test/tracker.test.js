import assert from "node:assert/strict";
import test from "node:test";
import { runTracker, resolveOutputMode, normalizeConfig } from "../src/tracker.js";
import { SOURCES, modelOutput, fixtureState, character } from "./fixtures.js";

test("configuration bounds and Claude provider alias", () => {
  const config = normalizeConfig({ maxTokens: 99999, timeoutMs: 1 });
  assert.equal(config.maxTokens, 16384); assert.equal(config.timeoutMs, 5000);
  assert.equal(resolveOutputMode({ provider: "claude" }, "auto"), "anthropic");
});
test("tracker forwards user scope, repairs once and has a shared request deadline", async () => {
  const requests = [], progress = [];
  const api = { connections: { get: async () => ({ provider: "anthropic" }) }, generate: { quiet: async input => { requests.push(input); return requests.length === 1 ? { content: "bad" } : { tool_calls: [{ name: "record_story_state", args: modelOutput(undefined, { initialize: true }) }] }; } } };
  const state = await runTracker(api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline", onProgress: event => progress.push(event) }, { connectionId: "tracker" }, "operator-user");
  assert.equal(state.characters[0].name, "Ada"); assert.equal(requests.length, 2);
  assert.equal(requests[0].userId, "operator-user"); assert.equal(requests[0].connection_id, "tracker"); assert.equal(requests[0].signal, requests[1].signal);
  assert.equal(requests[0].tools[0].name, "record_story_state");
  assert.deepEqual(progress, [{ stage: "generating", attempt: 1 }, { stage: "validating", attempt: 1 }, { stage: "repairing", attempt: 2 }, { stage: "validating", attempt: 2 }]);
});
test("failed repair rejects and initialization cannot omit a card character", async () => {
  let calls = 0;
  const output = modelOutput(undefined, { initialize: true }); output.characters = [];
  const api = { connections: { list: async () => [] }, generate: { quiet: async () => { calls++; return { content: JSON.stringify(output) }; } } };
  await assert.rejects(runTracker(api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline" }, {}, "user"), /Every card character/);
  assert.equal(calls, 2);
});

test("missing initial clock and weather receive one repair within the existing setup request budget", async () => {
  const requests = [], sources = structuredClone(SOURCES);
  sources.cards[0].scenario = "A quiet railway station.";
  const output = modelOutput(undefined, { initialize: true });
  for (const key of ["date", "time", "weather"]) output.world[key] = "Unknown";
  output.characters[0].internal.mood = "Unknown";
  const api = { connections: { list: async () => [] }, generate: { quiet: async request => {
    requests.push(structuredClone(request.messages));
    if (requests.length === 2) Object.assign(output.world, { date: "Day 1, early spring", time: "Morning", weather: "Light clouds" });
    return { content: JSON.stringify(output) };
  } } };
  const state = await runTracker(api, { initialize: true, sources, sourceMessageId: "card-baseline" }, {}, "owner");
  assert.equal(requests.length, 2);
  assert.match(requests[0][0].content, /Fill missing scene details is OFF/);
  for (const key of ["date", "time", "weather"]) assert.ok(requests[1].at(-1).content.includes(`world.${key}`));
  assert.equal(state.world.date, "Day 1, early spring"); assert.equal(state.world.time, "Morning"); assert.equal(state.world.weather, "Light clouds");
  assert.equal(state.characters[0].visible.dressAndLayers, "Blue coat"); assert.equal(state.characters[0].internal.mood, "Unknown");
});

test("unchecked setup repairs missing model outfits while allowing an unclothed NPC and an unknown user outfit", async () => {
  const sources = structuredClone(SOURCES), initial = fixtureState(), requests = [];
  sources.cards[0].first_mes = sources.selectedOpening = "Ada waits beside a fox and the traveler on the platform.";
  initial.characters[0].visible.dressAndLayers = initial.characters[0].internal.mood = "Unknown";
  const fox = character("npc:fox", "npc"); fox.name = "Fox"; fox.profile.identity = "Wild fox"; fox.visible.dressAndLayers = "Unknown";
  const user = character("user", "user");
  for (const section of [user.profile, user.appearance, user.visible, user.internal]) for (const key of Object.keys(section)) section[key] = "Unknown";
  initial.characters.push(fox, user);
  const api = { connections: { list: async () => [] }, generate: { quiet: async request => {
    requests.push(structuredClone(request.messages));
    if (requests.length === 2) {
      initial.characters[0].visible.dressAndLayers = "Plain work shirt and trousers";
      fox.visible.dressAndLayers = "Not applicable; a wild fox without clothing";
    }
    return { content: JSON.stringify(modelOutput(initial, { sources, initialize: true })) };
  } } };
  const state = await runTracker(api, { initialize: true, sources, sourceMessageId: "card-baseline" }, {}, "owner");
  assert.equal(requests.length, 2); assert.match(requests[0][0].content, /Fill missing scene details is OFF/);
  assert.match(requests[0][0].content, /Independently of the checkbox/);
  assert.match(requests[0][0].content, /Preserve supplied clothing, including partial descriptions/);
  assert.match(requests[0][0].content, /Never choose the user-controlled character's outfit/);
  const repair = requests[1].at(-1).content;
  assert.match(repair, /visible\.dressAndLayers for "Ada"/); assert.match(repair, /visible\.dressAndLayers for "Fox"/);
  assert.ok(!repair.includes('visible.dressAndLayers for "Traveler"'));
  assert.equal(state.characters[0].visible.dressAndLayers, "Plain work shirt and trousers");
  assert.equal(state.characters[0].internal.mood, "Unknown");
  assert.equal(state.characters.find(char => char.name === "Fox").visible.dressAndLayers, "Not applicable; a wild fox without clothing");
  assert.equal(state.characters.find(char => char.controller === "user").visible.dressAndLayers, "Unknown");
});

test("optional scene filling shares the extraction call and retains partial established scene values", async () => {
  let calls = 0;
  const output = modelOutput(undefined, { initialize: true });
  Object.assign(output.world, { date: "Late autumn", time: "After sunset", weather: "Rain", immediateContext: "Waiting at the station; muted light beneath the awning" });
  const api = { connections: { list: async () => [] }, generate: { quiet: async request => {
    calls++; const prompt = request.messages[0].content;
    assert.match(prompt, /Fill missing scene details is ON/);
    assert.match(prompt, /including approximate\/partial dates/);
    assert.match(prompt, /model-controlled characters only/);
    assert.match(prompt, /never a new hair color/);
    assert.match(prompt, /retaining its established context/);
    return { content: JSON.stringify(output) };
  } } };
  const state = await runTracker(api, { initialize: true, sources: SOURCES, fillMissingSceneDetails: true, sourceMessageId: "card-baseline" }, {}, "owner");
  assert.equal(calls, 1); assert.equal(state.world.date, "Late autumn"); assert.equal(state.world.time, "After sunset"); assert.equal(state.world.weather, "Rain");
  assert.equal(state.characters[0].visible.dressAndLayers, "Blue coat"); assert.equal(state.characters[0].visible.hairAndGrooming, "Black hair");
});

test("routine requests use extracted profiles and exclude raw cards while initialization retains sources", async () => {
  const sources = structuredClone(SOURCES); sources.cards[0].description += " RAW_CARD_ONLY_SENTINEL."; sources.cards[0].exampleDialogue = "EXAMPLE_ONLY_SENTINEL"; sources.selectedOpening = "OPENING_ONLY_SENTINEL";
  const previous = fixtureState(); previous.characters[0].profile.relationshipContext = "Longstanding station partnership"; previous.characters[0].profile.boundaries = "Do not open the private locker";
  previous.characters[0].visible.dressAndLayers = "Unknown";
  const requests = [], api = { connections: { list: async () => [] }, generate: { quiet: async input => {
    requests.push(input); const initialize = input.messages[1].content.startsWith("INITIALIZE");
    return { content: JSON.stringify(modelOutput(initialize ? fixtureState() : previous, { initialize })) };
  } } };
  await runTracker(api, { initialize: true, sources, sourceMessageId: "card-baseline" }, {}, "owner");
  const next = await runTracker(api, { sources, previousState: previous, userText: "Hello", assistantText: "Ada nods.", sourceMessageId: "a1" }, {}, "owner");
  assert.equal(next.characters[0].visible.dressAndLayers, "Unknown"); assert.equal(requests.length, 2);
  const initial = requests[0].messages[1].content, routine = requests[1].messages[1].content;
  for (const sentinel of ["RAW_CARD_ONLY_SENTINEL", "EXAMPLE_ONLY_SENTINEL", "OPENING_ONLY_SENTINEL"]) { assert.ok(initial.includes(sentinel)); assert.ok(!routine.includes(sentinel)); }
  assert.ok(routine.includes("Longstanding station partnership")); assert.ok(routine.includes("Do not open the private locker"));
});

test("provider formats and initialization/routine/refresh requests carry the alias contract", async () => {
  const guid = "12345678-1234-4321-8765-123456789abc", loreId = "87654321-1234-4321-8765-123456789abc";
  const sources = structuredClone(SOURCES); sources.cards[0].id = guid; sources.lore = [{ id: loreId, content: "Ada is allergic to shellfish." }];
  sources.cards[0].description += ` Reference char:${guid}.`; sources.cards[0].world_book_ids = [loreId];
  const previous = fixtureState(); previous.characters[0].id = `char:${guid}`;
  const requests = [], api = { connections: { get: async id => ({ provider: id }) }, generate: { quiet: async request => {
    requests.push(structuredClone({ messages: request.messages, parameters: request.parameters, tools: request.tools }));
    return { content: JSON.stringify(modelOutput(previous, { sources, initialize: request.messages[1].content.startsWith("INITIALIZE") })) };
  } } };
  // Provider transport and lifecycle context are independent axes; cover each
  // without repeating the entire Cartesian product.
  const cases = [["openai", "initial"], ["openai", "routine"], ["anthropic", "routine"], ["gemini", "routine"], ["plain", "routine"], ["openai", "refresh"]];
  for (const [provider, variant] of cases) {
    await runTracker(api, { sources, previousState: variant === "initial" ? null : previous, initialize: variant !== "routine", refreshProfiles: variant === "refresh", fillMissingSceneDetails: true,
      userText: "Offer shrimp", assistantText: "Ada declines.", sourceMessageId: "a1" }, { connectionId: provider }, "owner");
    const request = requests.at(-1), all = JSON.stringify(request);
    assert.equal(request.messages[0].content.includes("INITIAL SCENE DEFAULTS"), variant === "initial");
    assert.ok(!all.includes(guid)); assert.ok(!all.includes(loreId)); assert.ok(!request.messages[1].content.includes('"sourceMessageId":'));
    assert.ok(all.includes('c1')); assert.ok(all.includes('new_n1'));
    const schema = request.parameters.response_format?.json_schema.schema ?? request.parameters.responseSchema ?? request.tools?.[0].parameters;
    if (provider === "openai") assert.equal(request.parameters.response_format.type, "json_schema");
    if (provider === "anthropic") assert.equal(request.parameters.tool_choice.name, "record_story_state");
    if (provider === "gemini") assert.equal(request.parameters.responseMimeType, "application/json");
    if (provider === "plain") { assert.equal(schema, undefined); assert.equal(request.tools, undefined); }
    if (provider !== "plain") {
      assert.ok(schema.properties.characters.items.properties.id.enum.includes("c1"));
      assert.equal(schema.properties.characters.items.properties.id.enum.includes("c2"), false);
    }
    if (variant === "routine") assert.ok(request.messages[1].content.includes('"ownerId":"l1"'));
  }
  assert.equal(requests.length, cases.length);
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

test("scope repair identifies all rejected aliases and preserves valid selected updates", async () => {
  const previous = fixtureState();
  const ids = ["place:12345678-1234-4321-8765-123456789abc", "place:87654321-1234-4321-8765-123456789abc"];
  for (const [index, name] of ["Observatory", "Quarry"].entries()) previous.places.push({ ...previous.places[0], id: ids[index], name, description: "Distant hilltop" });
  let calls = 0;
  const api = { connections: { get: async () => ({ provider: "openai" }) }, generate: { quiet: async request => {
    calls++;
    const catalog = JSON.parse(request.messages[1].content.split("\n").at(-1));
    assert.deepEqual(catalog.existing.places.map(entry => entry.canUpdate), [true, false, false]);
    const schema = request.parameters.response_format.json_schema.schema;
    assert.ok(schema.properties.places.items.properties.id.enum.includes("p1"));
    assert.ok(!schema.properties.places.items.properties.id.enum.includes("p2"));
    const output = modelOutput(previous); output.characters[0].visible.dressAndLayers = "Coat on bench";
    if (calls === 1) for (const place of output.places.slice(1)) place.currentState = "Unsupported change";
    else {
      const repair = request.messages.at(-1).content;
      for (const term of ["p2", "p3", "Observatory", "Quarry"]) assert.ok(repair.includes(term));
      for (const id of ids) assert.ok(!JSON.stringify(request.messages).includes(id));
      output.places = output.places.slice(0, 1);
    }
    return { content: JSON.stringify(output) };
  } } };
  const state = await runTracker(api, { sources: SOURCES, previousState: previous, assistantText: "Ada removes her coat.", sourceMessageId: "a1" }, { connectionId: "tracker" }, "owner");
  assert.equal(calls, 2); assert.deepEqual(state.places, previous.places);
  assert.equal(state.characters[0].visible.dressAndLayers, "Coat on bench");
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
