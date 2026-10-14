import assert from "node:assert/strict";
import test from "node:test";
import { runTracker, generationParameters, resolveOutputMode, normalizeConfig, TRACKER_SYSTEM_PROMPT } from "../src/tracker.js";
import { SOURCES, outputState, fixtureState } from "./fixtures.js";

test("provider-specific structured output and bounded configuration", () => {
  const config = normalizeConfig({ maxTokens: 99999, timeoutMs: 1 });
  assert.equal(config.maxTokens, 16384); assert.equal(config.timeoutMs, 5000);
  assert.equal(resolveOutputMode({ provider: "claude" }, "auto"), "anthropic");
  assert.ok(generationParameters({ provider: "openai" }, config).response_format);
  assert.ok(generationParameters({ provider: "gemini" }, config).responseSchema);
});
test("tracker forwards user scope, repairs once and has a shared request deadline", async () => {
  const requests = [];
  const api = { connections: { get: async () => ({ provider: "anthropic" }) }, generate: { quiet: async input => { requests.push(input); return requests.length === 1 ? { content: "bad" } : { tool_calls: [{ name: "record_story_state", args: outputState() }] }; } } };
  const state = await runTracker(api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline" }, { connectionId: "tracker" }, "operator-user");
  assert.equal(state.characters[0].name, "Ada"); assert.equal(requests.length, 2);
  assert.equal(requests[0].userId, "operator-user"); assert.equal(requests[0].connection_id, "tracker"); assert.equal(requests[0].signal, requests[1].signal);
  assert.equal(requests[0].tools[0].name, "record_story_state");
});
test("failed repair rejects and initialization cannot omit a card character", async () => {
  let calls = 0;
  const output = outputState(); output.characters = [];
  const api = { connections: { list: async () => [] }, generate: { quiet: async () => { calls++; return { content: JSON.stringify(output) }; } } };
  await assert.rejects(runTracker(api, { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline" }, {}, "user"), /Every card character/);
  assert.equal(calls, 2);
  assert.ok(TRACKER_SYSTEM_PROMPT.includes("fictional narrative clock, never wall-clock time"));
  assert.ok(TRACKER_SYSTEM_PROMPT.includes("User internal fields must all be Unknown"));
});

test("routine requests use extracted profiles and exclude raw cards while initialization retains sources", async () => {
  const sources = structuredClone(SOURCES); sources.cards[0].description += " RAW_CARD_ONLY_SENTINEL."; sources.cards[0].exampleDialogue = "EXAMPLE_ONLY_SENTINEL"; sources.selectedOpening = "OPENING_ONLY_SENTINEL";
  const previous = fixtureState(); previous.characters[0].profile.relationshipContext = "Longstanding station partnership"; previous.characters[0].profile.boundaries = "Do not open the private locker";
  const requests = [], api = { connections: { list: async () => [] }, generate: { quiet: async input => { requests.push(input); return { content: JSON.stringify(outputState(previous)) }; } } };
  await runTracker(api, { initialize: true, sources, sourceMessageId: "card-baseline" }, {}, "owner");
  await runTracker(api, { sources, previousState: previous, userText: "Hello", assistantText: "Ada nods.", sourceMessageId: "a1" }, {}, "owner");
  const initial = requests[0].messages[1].content, routine = requests[1].messages[1].content;
  for (const sentinel of ["RAW_CARD_ONLY_SENTINEL", "EXAMPLE_ONLY_SENTINEL", "OPENING_ONLY_SENTINEL"]) { assert.ok(initial.includes(sentinel)); assert.ok(!routine.includes(sentinel)); }
  assert.ok(routine.includes("Longstanding station partnership")); assert.ok(routine.includes("Do not open the private locker")); assert.ok(!routine.includes("STABLE CARD SOURCES"));
});
