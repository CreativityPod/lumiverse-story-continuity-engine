import assert from "node:assert/strict";
import test from "node:test";
import { runTracker, generationParameters, resolveOutputMode, normalizeConfig, TRACKER_SYSTEM_PROMPT } from "../src/tracker.js";
import { SOURCES, outputState } from "./fixtures.js";

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
