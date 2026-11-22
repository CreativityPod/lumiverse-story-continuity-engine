import assert from "node:assert/strict";
import test from "node:test";
import { retrieveRelevantState, decisionRetrievalAvailability, clearRetrievalCache } from "../src/retrieval.js";
import { selectRelevantState, buildRoleplayContext, buildVisualContext, buildRoutineTrackerContext } from "../src/context.js";
import { renderContinuityContext } from "../src/render.js";
import { normalizeConfig, runTracker, DEFAULT_CONFIG } from "../src/tracker.js";
import { character, fixtureState, SOURCES, modelOutput } from "./fixtures.js";

const jevConfig = { ...DEFAULT_CONFIG, retrievalMode: "jev", retrievalConnectionId: "decision-connection" };
function retrievalFixture() {
  const state = fixtureState(), sister = character("npc:mira", "npc");
  sister.name = "Mira"; sister.visible.position = "Northern observatory";
  sister.profile.relationshipContext = "Ada's sister";
  sister.internal.knowledge = "Knows the clock was sabotaged";
  sister.internal.beliefs = "Suspects Ada is responsible; unconfirmed";
  sister.internal.intent = "Keep the appointment";
  state.characters.push(sister);
  state.places.push({ ...state.places[0], id: "place:observatory", name: "Observatory", description: "Distant hilltop", privateFacts: "Mira's notes are hidden here" });
  state.relationships.push({ id: "rel:sisters", fromId: "char:ada", toId: "npc:mira", publicStatus: "Sisters", privateState: "Mira distrusts Ada; Ada is unaware", boundaryOrConcern: "Unknown", sourceMessageId: "card-baseline" });
  state.objectives.push({ id: "objective:appointment", ownerId: "npc:mira", objective: "Meet Ada tomorrow", timing: "Tomorrow", status: "active", sourceMessageId: "card-baseline" });
  return state;
}
function score(value = 0, confidence = 1) {
  return { type: "score", score: value, confidence, probabilities: value === 2 ? { "0": 0, "1": 0, "2": 1 } : { "0": 1 - value / 2, "1": 0, "2": value / 2 }, legend: {} };
}
function decisionAnswers(request, selected = []) {
  return { model: "jev-test", answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key,
    score(selected.some(alias => question.instructions.includes(`alias ${alias}.`)) ? 2 : 0)])) };
}
function apiFixture(handler) {
  const requests = [], permissions = new Set(["decisions"]);
  const api = { host: { capabilities: { "decisions-v1": 1 } }, permissions: { has: permission => permissions.has(permission) },
    decisions: { evaluate: async (request, options) => { requests.push({ request, options }); return handler ? handler(request, options) : decisionAnswers(request, ["n1"]); } } };
  return { api, requests, permissions };
}
const evidence = { sources: SOURCES, userId: "owner", purpose: "roleplay", userText: "What did your sister promise?", assistantText: "Ada pauses." };
const query = `${evidence.userText}\n${evidence.assistantText}`;

test("Jev retrieves an indirect family reference from full saved state without changing facts or knowledge ownership", async () => {
  const state = retrievalFixture(), before = JSON.stringify(state), h = apiFixture();
  assert.deepEqual(selectRelevantState(state, query).characters.map(char => char.name), ["Ada"]);
  const result = await retrieveRelevantState(h.api, state, query, jevConfig, evidence);
  assert.equal(result.info.outcome, "selected"); assert.equal(result.info.added.characters, 1);
  const selected = selectRelevantState(state, query, result);
  assert.deepEqual(selected.characters.map(char => char.name), ["Ada", "Mira"]);
  assert.equal(selected.relationships.length, 1); assert.equal(selected.objectives.length, 1);
  const request = h.requests[0].request, wire = JSON.stringify(request);
  assert.equal(request.connection_id, "decision-connection"); assert.equal(request.userId, "owner");
  assert.equal(request.state.latestUserMessage, evidence.userText); assert.equal(request.state.previousAssistantResponse, evidence.assistantText);
  for (const secret of ["char:ada", "npc:mira", "rel:sisters", "sourceMessageId", CARD_SENTINEL]) assert.ok(!wire.includes(secret), secret);
  assert.ok(wire.includes("Ada's sister")); assert.ok(wire.includes("Suspects Ada is responsible"));
  assert.ok(!wire.includes("INITIALIZE")); assert.ok(Object.keys(request.questions).length <= 256);
  const context = buildRoleplayContext(state, query, { ...result, sources: SOURCES }), text = renderContinuityContext(context);
  assert.match(text, /BELIEFS \/ SUSPICIONS: Suspects Ada/); assert.match(text, /not shared knowledge or confirmed world facts/);
  const ada = context.characters.find(char => char.name === "Ada");
  assert.equal(ada.internal.knowledge, "Knows the signal is faulty");
  assert.equal(JSON.stringify(state), before);
});
const CARD_SENTINEL = "Her secret affiliation is"; // Raw card sources are not retransmitted for relevance ranking.

test("semantic relationship and objective selection includes saved endpoints and owners", async () => {
  for (const alias of ["r1", "o1"]) {
    const state = retrievalFixture(), h = apiFixture(request => decisionAnswers(request, [alias]));
    const result = await retrieveRelevantState(h.api, state, query, jevConfig, evidence);
    const selected = selectRelevantState(state, query, result);
    assert.ok(selected.characters.some(char => char.name === "Mira"));
    assert.equal(selected.characters[1].visible.position, "Northern observatory");
    const tracker = buildRoutineTrackerContext({ previousState: state, ...evidence, ...result });
    assert.ok(tracker.allowedUpdateIds.characters.has("npc:mira"));
    assert.ok(tracker.allowedUpdateIds.relationships.has("rel:sisters"));
    assert.equal(tracker.state.characters[0].internal.beliefs, "Unknown");
  }
});

test("Jev cannot veto local selection, change values, create identities or expand the visual mirror", async () => {
  const state = retrievalFixture(), h = apiFixture(request => decisionAnswers(request));
  const result = await retrieveRelevantState(h.api, state, query, jevConfig, evidence);
  assert.deepEqual(selectRelevantState(state, query, result), selectRelevantState(state, query));
  const attempted = { retrievedIds: { characters: ["npc:mira", "new_n1", { id: "user", name: "Injected" }], places: ["not-saved"] } };
  assert.deepEqual(selectRelevantState(state, query, attempted).characters.map(char => char.name), ["Ada", "Mira"]);
  assert.equal(buildVisualContext(state, attempted), buildVisualContext(state));
  assert.ok(!buildVisualContext(state, attempted).includes("Mira"));
});

test("uncertain relevance is included and the roleplay text remains bounded", async () => {
  const state = retrievalFixture(), h = apiFixture(request => {
    const result = decisionAnswers(request); result.answers.record_1 = score(.1, .1); return result;
  });
  const result = await retrieveRelevantState(h.api, state, query, jevConfig, evidence);
  assert.ok(result.retrievedIds.characters.includes("npc:mira"));
  const text = renderContinuityContext(buildRoleplayContext(state, query, { ...result, maxChars: 1800 }));
  assert.ok(text.length <= 1800); assert.match(text, /omitted/);
});

test("disabled, unsupported and ungranted retrieval never calls the Decision API", async () => {
  const state = retrievalFixture(), h = apiFixture();
  assert.equal((await retrieveRelevantState(h.api, state, query, DEFAULT_CONFIG, evidence)).info.outcome, "disabled");
  h.api.host.capabilities = {};
  assert.equal((await retrieveRelevantState(h.api, state, query, jevConfig, evidence)).info.outcome, "unavailable");
  h.api.host.capabilities["decisions-v1"] = 1; h.permissions.clear();
  assert.equal(decisionRetrievalAvailability(h.api).available, false);
  assert.equal((await retrieveRelevantState(h.api, state, query, jevConfig, evidence)).info.outcome, "unavailable");
  assert.equal(h.requests.length, 0);
  assert.equal((await retrieveRelevantState(apiFixture().api, fixtureState(), "Ada nods.", jevConfig, evidence)).info.outcome, "not_needed");
});

test("invalid or failed Decision results fall back without retaining raw provider evidence", async () => {
  const failures = [
    () => { throw new Error("PRIVATE_PROVIDER_ERROR should never be displayed"); },
    () => ({ model: "jev", answers: {} }),
    request => { const r = decisionAnswers(request, ["n1"]); r.answers.record_1.score = 200; return r; },
    request => { const r = decisionAnswers(request, ["n1"]); r.answers.record_1.probabilities = { "2": 1 }; return r; },
    request => { const r = decisionAnswers(request, ["n1"]); r.answers.new_n1 = score(2); return r; },
  ];
  for (const failure of failures) {
    const h = apiFixture(failure), result = await retrieveRelevantState(h.api, retrievalFixture(), query, jevConfig, evidence);
    assert.equal(result.info.outcome, "fallback"); assert.equal(result.retrievedIds, undefined);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_PROVIDER_ERROR"));
  }
});

test("timeout aborts a nonresponsive Decision call without waiting for host cancellation", async () => {
  const h = apiFixture(() => new Promise(() => {}));
  const result = await retrieveRelevantState(h.api, retrievalFixture(), query, jevConfig, { ...evidence, timeoutMs: 100 });
  assert.equal(result.info.outcome, "fallback"); assert.match(result.info.reason, /timed out/);
  assert.equal(h.requests[0].options.signal.aborted, true);
});

test("permission revocation during selection discards the answer", async () => {
  const h = apiFixture(request => { h.permissions.clear(); return decisionAnswers(request, ["n1"]); });
  const result = await retrieveRelevantState(h.api, retrievalFixture(), query, jevConfig, evidence);
  assert.equal(result.info.outcome, "unavailable"); assert.equal(result.retrievedIds, undefined);
});

test("oversized evidence is not truncated or sent to a Decision provider", async () => {
  const h = apiFixture(), state = retrievalFixture();
  const result = await retrieveRelevantState(h.api, state, query, jevConfig, { ...evidence, userText: "界".repeat(310000) });
  assert.equal(result.info.outcome, "fallback"); assert.match(result.info.reason, /too large/);
  assert.equal(result.retrievedIds, undefined); assert.equal(h.requests.length, 0);
});

test("Decision time is deducted from the shared tracker deadline", async t => {
  let now = Date.now(); const budgets = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(AbortSignal, "timeout", ms => { budgets.push(ms); return new AbortController().signal; });
  const state = retrievalFixture(), h = apiFixture(request => { now += 3000; return decisionAnswers(request, ["n1"]); });
  h.api.connections = { list: async () => [] };
  h.api.generate = { quiet: async () => ({ content: JSON.stringify(modelOutput(state)) }) };
  await runTracker(h.api, { previousState: state, sources: SOURCES, userText: evidence.userText, assistantText: "Ada nods.", sourceMessageId: "a1", remainingMs: 20000 }, jevConfig, "owner");
  assert.deepEqual(budgets, [17000]);
});

test("cache respects evidence, purpose, account, connection, identity mapping, state and explicit invalidation", async () => {
  const h = apiFixture(), state = retrievalFixture();
  await retrieveRelevantState(h.api, state, query, jevConfig, evidence);
  assert.equal((await retrieveRelevantState(h.api, state, query, jevConfig, evidence)).info.outcome, "cached");
  assert.equal(h.requests.length, 1);
  for (const options of [{ ...evidence, userText: "Different input" }, { ...evidence, purpose: "tracking" }, { ...evidence, userId: "other" }])
    await retrieveRelevantState(h.api, state, query, jevConfig, options);
  await retrieveRelevantState(h.api, state, query, { ...jevConfig, retrievalConnectionId: "different" }, evidence);
  const other = retrievalFixture(); other.characters[1].id = "npc:different"; other.relationships[0].toId = "npc:different"; other.objectives[0].ownerId = "npc:different";
  const result = await retrieveRelevantState(h.api, other, query, jevConfig, evidence);
  assert.deepEqual(result.retrievedIds.characters, ["npc:different"]);
  state.characters[1].internal.beliefs = "Suspects someone else";
  await retrieveRelevantState(h.api, state, query, jevConfig, evidence);
  clearRetrievalCache(h.api); await retrieveRelevantState(h.api, state, query, jevConfig, evidence);
  assert.equal(h.requests.length, 8);
});

test("ordinary tracking uses the completed pair and one Decision call across a targeted repair", async () => {
  const state = retrievalFixture(), h = apiFixture(); let generation = 0, diagnostics;
  h.api.connections = { list: async () => [] };
  h.api.generate = { quiet: async request => {
    generation++;
    const out = modelOutput(state);
    if (generation === 1) out.characters[0].visible.activity = "bad <story_continuity> markup";
    assert.match(request.messages[1].content, /Mira/);
    assert.match(request.messages[1].content, /COMPLETED USER TURN\nWhat did your sister promise/);
    return { content: JSON.stringify(out) };
  } };
  const result = await runTracker(h.api, { previousState: state, sources: SOURCES, userText: evidence.userText, assistantText: "Ada mentions her sister's promise.", sourceMessageId: "a1", onDiagnostic: value => { diagnostics = value; } }, jevConfig, "owner");
  assert.equal(h.requests.length, 1); assert.equal(generation, 2);
  assert.equal(h.requests[0].request.state.completedAssistantTurn, "Ada mentions her sister's promise.");
  assert.ok(!Object.hasOwn(h.requests[0].request.state, "previousAssistantResponse"));
  assert.equal(diagnostics.retrieval.outcome, "selected"); assert.ok(!JSON.stringify(diagnostics.retrieval).includes("Mira"));
  assert.equal(result.characters[1].internal.knowledge, state.characters[1].internal.knowledge);
});

test("configuration preserves opt-in retrieval settings without changing tracker connection", () => {
  assert.equal(normalizeConfig().retrievalMode, "local");
  const config = normalizeConfig({ retrievalMode: "jev", retrievalConnectionId: " decision ", connectionId: "tracker" });
  assert.equal(config.retrievalConnectionId, "decision"); assert.equal(config.connectionId, "tracker");
  assert.equal(normalizeConfig({ retrievalMode: "injected", retrievalConnectionId: {} }).retrievalMode, "local");
  assert.equal(normalizeConfig({ retrievalConnectionId: {} }).retrievalConnectionId, "");
});
