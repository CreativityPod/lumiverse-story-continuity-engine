import assert from "node:assert/strict";
import { runTracker } from "../src/tracker.js";
import { fixtureState, SOURCES } from "../test/fixtures.js";

// Explicit opt-in: this uses real generations on an existing local Lumiverse
// connection. It creates no chats, edits no settings, and saves no story data.
if (!process.argv.includes("--live")) {
  console.log("Provider smoke test (opt-in): set LUMIVERSE_URL, STORY_SMOKE_CONNECTION and optionally LUMIVERSE_COOKIE, then run npm run smoke -- --live. Exercises setup, a clothing update and a new NPC; up to six generations. Prints metadata only.");
  process.exit(0);
}
const url = new URL(process.env.LUMIVERSE_URL ?? "http://127.0.0.1:8000");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Smoke endpoint must be the local Lumiverse server");
assert.ok(process.env.STORY_SMOKE_CONNECTION, "STORY_SMOKE_CONNECTION must identify an existing connection");
async function request(path, body, signal) {
  const response = await fetch(new URL(`/api/v1/${path}`, url), { method: body ? "POST" : "GET", signal,
    headers: { "Content-Type": "application/json", Origin: url.origin, ...(process.env.LUMIVERSE_COOKIE ? { Cookie: process.env.LUMIVERSE_COOKIE } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Local Lumiverse request failed: HTTP ${response.status}`);
  return response.json();
}
const api = {
  connections: { get: id => request(`connections/${encodeURIComponent(id)}`) },
  presets: { get: id => request(`presets/${encodeURIComponent(id)}`) },
  generate: { quiet: ({ signal, messages, parameters, tools, connection_id, reasoning }) => request("generate/quiet", { messages, parameters, tools, connection_id, reasoning }, signal) },
};
const config = { connectionId: process.env.STORY_SMOKE_CONNECTION, outputMode: process.env.STORY_SMOKE_OUTPUT_MODE ?? "auto" };
let failed = false;
for (const scenario of [
  { name: "initial setup", input: { initialize: true, sources: SOURCES, sourceMessageId: "card-baseline" }, check: state => { assert.equal(state.characters[0].name, "Ada"); assert.notEqual(state.characters[0].profile.identity, "Unknown"); assert.notEqual(state.characters[0].profile.personality, "Unknown"); } },
  { name: "clothing update", input: { sources: SOURCES, previousState: fixtureState(), sourceMessageId: "smoke-clothes", userText: "Please take off your coat.", assistantText: "Ada removes her blue coat and folds it on the bench. She is wearing a white shirt underneath." }, check: state => assert.match(state.characters[0].visible.dressAndLayers, /shirt|bench/i) },
  { name: "new NPC and relationship", input: { sources: SOURCES, previousState: fixtureState(), sourceMessageId: "smoke-npc", userText: "Who just arrived?", assistantText: "Rae, the station's shift supervisor, arrives on the platform. Ada introduces Rae by name and explains that they have been colleagues for years." }, check: state => { const npc = state.characters.find(char => char.name === "Rae" && char.role === "npc"); assert.ok(npc); assert.ok(state.relationships.some(rel => rel.fromId === npc.id || rel.toId === npc.id)); } },
]) {
  let diagnostics;
  try {
    const state = await runTracker(api, { ...scenario.input, onDiagnostic: detail => { diagnostics = detail; } }, config);
    scenario.check(state);
  } catch { failed = true; console.log(JSON.stringify({ scenario: scenario.name, result: "failed" })); }
  console.log(JSON.stringify({ scenario: scenario.name, outcome: diagnostics?.outcome ?? "unavailable", provider: diagnostics?.provider,
    model: diagnostics?.model, outputMode: diagnostics?.outputMode, elapsedMs: diagnostics?.elapsedMs,
    attempts: diagnostics?.attempts.map(({ category, finishReason, contentChars, toolCalls, usage }) => ({ category, finishReason, contentChars, toolCalls, usage })) }));
}
process.exitCode = failed ? 1 : 0;
