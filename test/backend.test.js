import assert from "node:assert/strict";
import test from "node:test";
import { createStoryEngine } from "../src/backend.js";
import { formatStoryClockValue } from "../src/clock.js";
import { CHAT_KEYS, SETUP_FORMAT, IMPORT_LOADED_TEXT, INITIALIZATION_NOTICE_TEXT, isInitializationNotice, listEligibleTurns, fingerprint } from "../src/state.js";
import { remapStateSources, legacyTrackerState } from "../src/schemas.js";
import { CARD, SOURCES, fixtureState, modelOutput } from "./fixtures.js";

function harness() {
  const files = new Map(), variables = new Map(), events = new Map(), sent = [], requests = [], noticeDeletes = [];
  const messages = new Map([["chat", [{ id: "a0", role: "assistant", content: CARD.first_mes, swipe_id: 0 }]]]);
  const cards = new Map([["ada", structuredClone(CARD)]]), chats = new Map([["chat", { id: "chat", character_id: "ada", metadata: {} }]]);
  let response = null, messageSequence = 0;
  const permissions = new Set(["generation", "interceptor", "chat_mutation", "characters", "chats", "ui_panels"]);
  const api = {
    permissions: { has: permission => permissions.has(permission), onChanged: () => {} },
    storage: { getJson: async (path, options) => structuredClone(files.get(path) ?? options?.fallback), setJson: async (path, value) => files.set(path, structuredClone(value)),
      list: async prefix => [...files.keys()].filter(path => path.startsWith(`${prefix}/`)).map(path => path.slice(prefix.length + 1)),
      read: async path => JSON.stringify(files.get(path)), delete: async path => files.delete(path) },
    variables: { chat: { set: async (id, key, value) => variables.set(`${id}:${key}`, value) } },
    chats: { get: async id => structuredClone(chats.get(id) ?? null) }, characters: { get: async id => structuredClone(cards.get(id) ?? null) },
    chat: { getMessages: async id => { if (!messages.has(id)) throw new Error("Chat not found"); return structuredClone(messages.get(id)); },
      appendMessage: async (id, message, options) => { const entry = { ...message, id: `appended-${++messageSequence}`, swipe_id: 0 }; messages.get(id).push(entry);
        if (options?.triggerGeneration) messages.get(id).push({ id: "begin-response", role: "assistant", content: "Ada waits at the station." }); return { id: entry.id }; },
      deleteMessage: async (chatId, messageId) => {
        const entry = messages.get(chatId)?.find(message => message.id === messageId); if (!entry) throw new Error("Message not found");
        messages.set(chatId, messages.get(chatId).filter(message => message.id !== messageId));
        if (isInitializationNotice(entry)) noticeDeletes.push(structuredClone(entry));
        if (isInitializationNotice(entry)) await events.get("MESSAGE_DELETED")?.({ chatId, messageId,
          message: { id: entry.id, is_user: false, content: entry.content, extra: { spindle_metadata: entry.metadata } } }, "owner");
      } },
    connections: { list: async () => [{ id: "default", provider: "openai", is_default: true }], get: async () => null },
    generate: { quiet: async input => { requests.push(input); if (response) return response(input); const state = modelOutput(undefined, { initialize: input.messages[1].content.startsWith("INITIALIZE") });
      if (input.messages[1].content.includes("Coat removed")) state.characters[0].visible.dressAndLayers = "White shirt; blue coat on bench";
      if (input.messages[1].content.includes("Door opened")) state.places[0].currentState = "Side door open";
      return { content: JSON.stringify(state) }; } },
    sendToFrontend: (payload, userId) => sent.push({ payload, userId }), registerInterceptor: handler => { api.interceptor = handler; },
    onFrontendMessage: handler => { api.frontend = handler; }, on: (name, handler) => events.set(name, handler), log: { info() {}, warn() {} },
  };
  const engine = createStoryEngine(api);
  const open = async (chatId = "chat") => engine.handleFrontend({ type: "story_get_status", chatId }, "owner");
  const create = async (chatId = "chat") => engine.handleFrontend({ type: "story_create_setup", chatId, requestId: "create" }, "owner");
  const select = async (chatId = "chat") => { await open(chatId); if ((await engine.loadStore(chatId)).awaitingSetup) await create(chatId); };
  const addTurn = (text, id = "a1") => messages.get("chat").push({ id: `u-${id}`, role: "user", content: "Continue" }, { id, role: "assistant", content: text, swipe_id: 0 });
  return { api, engine, files, variables, messages, cards, chats, events, sent, requests, noticeDeletes, permissions, select, open, create, addTurn, setResponse: handler => { response = handler; } };
}

function addLegacyNotice(h, phase = "ready", id = "legacy-notice") {
  const notice = { id, role: "system", content: INITIALIZATION_NOTICE_TEXT[phase], metadata: { story_continuity_notice: { version: 1, status: phase } } };
  h.messages.get("chat").push(notice); return notice;
}

test("failed response evidence stays private, persists across restart, and exposes pending/last tracked turns", async () => {
  const h = harness(); await h.select(); const previous = (await h.engine.loadStore("chat")).current;
  h.addTurn("Ada nods."); h.setResponse(async () => ({ content: "PRIVATE_RESPONSE_EXCERPT", finish_reason: "length", usage: { completion_tokens: 30 } }));
  await h.engine.schedule("chat", {}, "owner");
  const failed = await h.engine.loadStore("chat");
  assert.deepEqual(failed.current, previous); assert.equal(failed.trackerMetrics.firstPass, 1); assert.equal(failed.trackerMetrics.failed, 1);
  assert.equal(failed.trackerMetrics.completionTokens, 60);
  assert.equal(failed.trackerDiagnostics.attempts[1].excerpt, "PRIVATE_RESPONSE_EXCERPT");
  const publicStatus = await h.engine.status("chat", "owner", false);
  assert.equal(publicStatus.trackerInfo.retryPaused, true); assert.equal(publicStatus.trackerInfo.pendingMessageId, "a1");
  assert.equal(publicStatus.trackerInfo.lastTrackedMessageId, "a0");
  assert.ok(!JSON.stringify(publicStatus).includes("PRIVATE_RESPONSE_EXCERPT"));
  assert.ok(![...h.variables.values()].join(" ").includes("PRIVATE_RESPONSE_EXCERPT"));
  const restarted = createStoryEngine(h.api);
  await restarted.schedule("chat", {}, "owner"); assert.equal(h.requests.length, 3);
  const privateStatus = await restarted.status("chat", "owner", true);
  assert.equal(privateStatus.trackerDiagnostics.attempts.length, 2);
  assert.ok(JSON.stringify(privateStatus).includes("PRIVATE_RESPONSE_EXCERPT"));
  h.setResponse(null); await restarted.schedule("chat", { reprocess: true }, "owner");
  const recovered = await restarted.status("chat", "owner", true);
  assert.equal(recovered.trackerInfo.pendingMessageId, ""); assert.equal(recovered.trackerInfo.lastTrackedMessageId, "a1");
  assert.equal(recovered.trackerMetrics.firstPass, 2);
});

test("initial world failure displays validated profiles across restart without committing or exposing private facts", async () => {
  const h = harness(), response = modelOutput(undefined, { initialize: true }); response.world.sceneStatus = "in_progress";
  h.setResponse(async () => ({ content: JSON.stringify(response), finish_reason: "stop" }));
  await h.select(); assert.equal(h.requests.length, 2);
  const saved = await h.engine.loadStore("chat");
  assert.equal(saved.baseline, null); assert.equal(saved.current, null); assert.equal(saved.initialSetup, null);
  assert.equal(saved.setupDraft.state.characters[0].profile.identity, "Mechanic");
  const status = await h.engine.status("chat", "owner");
  assert.equal(status.snapshot, null); assert.equal(status.setupPreview.snapshot.characters[0].visible.dressAndLayers, "Blue coat");
  assert.equal(status.setupPreview.snapshot.world.weather, "Rain");
  assert.equal(status.setupPreview.snapshot.world.sceneStatus, "Unavailable — needs repair");
  assert.equal(status.canExport, false); assert.ok(!JSON.stringify(status).includes("Lantern Guild"));
  assert.ok(![...h.variables.values()].join(" ").includes("Blue coat"));
  const prompt = await h.engine.intercept([{ role: "user", content: "Continue" }], { chatId: "chat", userId: "owner" });
  assert.ok(!JSON.stringify(prompt).includes("Blue coat")); assert.equal(h.requests.length, 2);
  const restarted = createStoryEngine(h.api); await restarted.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 2);
  const privateStatus = await restarted.status("chat", "owner", true);
  assert.equal(privateStatus.setupPreviewState.characters[0].profile.identity, "Mechanic");
  assert.equal(privateStatus.setupPreviewState.world.sceneStatus, "Unavailable — needs repair");
  h.setResponse(null); await restarted.handleFrontend({ type: "story_get_status", chatId: "chat" }, "owner");
  await restarted.handleFrontend({ type: "story_create_setup", chatId: "chat", requestId: "retry-preview" }, "owner");
  const complete = await restarted.status("chat", "owner", true);
  assert.equal(complete.code, "active"); assert.equal(complete.setupPreview, null); assert.equal(complete.setupPreviewState, null);
  assert.equal((await restarted.loadStore("chat")).setupDraft, null);
});

test("reference-only setup repair cannot commit a missing outfit and Retry reuses saved world defaults", async () => {
  const h = harness(), initial = modelOutput(undefined, { initialize: true }), original = structuredClone(h.messages.get("chat"));
  for (const field of ["date", "time", "weather"]) initial.world[field] = "Unknown";
  initial.characters[0].visible.dressAndLayers = "Unknown";
  initial.relationships.push({ id: "new_r1", action: "update", changes: [{ field: "fromId", value: "c1" }, { field: "toId", value: "new_u1" }] });
  const referenceOnlyRepair = { schemaVersion: 3, world: { action: "preserve", changes: [] },
    characters: [{ id: "new_u1", action: "update", changes: [{ field: "name", value: "User" }] }],
    relationships: [{ id: "new_r1", action: "update", changes: [{ field: "toId", value: "new_u1" }] }], places: [], objectives: [] };
  h.setResponse(async () => ({ content: JSON.stringify(h.requests.length === 1 ? initial : referenceOnlyRepair), finish_reason: "stop" }));
  await h.select(); assert.equal(h.requests.length, 2);
  const failed = await h.engine.loadStore("chat");
  assert.equal(failed.baseline, null); assert.equal(failed.current, null); assert.deepEqual(failed.checkpoints, {});
  assert.equal(failed.setupDraft.state.characters[0].profile.identity, "Mechanic");
  assert.equal(failed.trackerDiagnostics.attempts[0].issues.length, 2);
  const defaults = failed.initialWorldDefaults;
  for (const field of ["date", "time", "weather"]) assert.equal(failed.setupDraft.state.world[field], defaults.values[field]);
  assert.deepEqual(failed.setupDraft.unavailableFields, []);
  assert.equal(h.variables.get(`chat:${CHAT_KEYS.visual}`), ""); assert.deepEqual(h.messages.get("chat"), original);
  const restarted = createStoryEngine(h.api), retry = modelOutput(undefined, { initialize: true });
  for (const field of ["date", "time", "weather"]) retry.world[field] = "Unknown";
  h.setResponse(async () => ({ content: JSON.stringify(retry) }));
  await restarted.schedule("chat", {}, "owner"); assert.equal(h.requests.length, 2);
  await restarted.handleFrontend({ type: "story_create_setup", chatId: "chat", requestId: "retry-incomplete" }, "owner");
  assert.equal(h.requests.length, 3); assert.equal((await restarted.loadStore("chat")).current.characters[0].name, "Ada");
  assert.deepEqual((await restarted.loadStore("chat")).initialWorldDefaults, defaults);
  for (const field of ["date", "time", "weather"]) assert.equal((await restarted.loadStore("chat")).current.world[field], defaults.values[field]);
  assert.match(h.variables.get(`chat:${CHAT_KEYS.visual}`), /DRESS & LAYERS: Blue coat/);
  assert.deepEqual(h.messages.get("chat"), original);
});

test("programmatic world defaults survive restart, reprocess and portable setup import without extra calls", async () => {
  const h = harness(), proposed = modelOutput(undefined, { initialize: true });
  for (const field of ["date", "time", "weather"]) proposed.world[field] = "Unknown";
  h.setResponse(async () => ({ content: JSON.stringify(proposed) }));
  await h.select(); assert.equal(h.requests.length, 1);
  const store = await h.engine.loadStore("chat"), values = store.initialWorldDefaults.values;
  for (const field of ["date", "time", "weather"]) assert.equal(store.current.world[field], values[field]);
  assert.ok(h.variables.get(`chat:${CHAT_KEYS.visual}`).includes(formatStoryClockValue("date", values.date)));
  const restarted = createStoryEngine(h.api);
  await restarted.schedule("chat", { reprocess: true }, "owner"); assert.equal(h.requests.length, 1);
  for (const field of ["date", "time", "weather"]) assert.equal((await restarted.loadStore("chat")).current.world[field], values[field]);
  await restarted.handleFrontend({ type: "story_export_setup", chatId: "chat", requestId: "random-export" }, "owner");
  const exported = h.sent.at(-1).payload; assert.equal(exported.ok, true);
  assert.ok(!exported.fileText.includes("initialWorldDefaults"));
  await restarted.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: exported.fileText, requestId: "random-import" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 1);
  for (const field of ["date", "time", "weather"]) assert.equal((await restarted.loadStore("chat")).current.world[field], values[field]);
});

test("filling missing age/gender preserves scenes and known values across checkpoints, macros and restart", async () => {
  const h = harness(), initial = fixtureState();
  h.cards.get("ada").description += " Age: early thirties. Gender: woman.";
  initial.characters[0].profile.gender = "Woman";
  h.setResponse(async () => ({ content: JSON.stringify(modelOutput(initial, { initialize: true })) }));
  await h.select(); h.addTurn("Coat removed");
  h.setResponse(async () => ({ content: JSON.stringify({ schemaVersion: 3, world: { action: "preserve", changes: [] },
    characters: [{ id: "c1", action: "update", changes: [{ field: "visible.dressAndLayers", value: "White shirt; coat on bench" }] }],
    relationships: [], places: [], objectives: [] }) }));
  await h.engine.schedule("chat", {}, "owner");
  const before = await h.engine.loadStore("chat"), extracted = structuredClone(before.current);
  Object.assign(extracted.characters[0].profile, { age: "Early thirties", gender: "Man", identity: "Wrong replacement identity" });
  extracted.world.weather = "Snow"; extracted.characters[0].visible.dressAndLayers = "Wrong outfit";
  h.setResponse(async request => {
    assert.match(request.messages[1].content, /FILL MISSING AGE AND GENDER ONLY/);
    assert.ok(!request.messages[0].content.includes("INITIAL SCENE DEFAULTS —"));
    return { content: JSON.stringify(modelOutput(extracted, { sources: before.sources })) };
  });
  await h.engine.handleFrontend({ type: "story_fill_identity", chatId: "chat" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 3);
  const after = await h.engine.loadStore("chat");
  for (const [oldState, next] of [[before.baseline, after.baseline], [before.current, after.current], [before.initialSetup.state, after.initialSetup.state],
    ...Object.keys(before.checkpoints).map(key => [before.checkpoints[key].state, after.checkpoints[key].state])]) {
    const expected = structuredClone(oldState); expected.characters[0].profile.age = "Early thirties";
    assert.deepEqual(next, expected);
  }
  assert.equal(after.revision, before.revision + 1);
  const full = JSON.parse(h.variables.get(`chat:${CHAT_KEYS.state}`));
  assert.equal(full.schemaVersion, 3); assert.equal(full.characters[0].profile.age, "Early thirties");
  const v2 = JSON.parse(h.variables.get(`chat:${CHAT_KEYS.previousState}`));
  assert.equal(v2.schemaVersion, 2); assert.equal(v2.characters[0].profile.age, undefined); assert.equal(v2.characters[0].profile.gender, undefined);
  const publicNow = JSON.parse(h.variables.get(`chat:${CHAT_KEYS.public}`));
  assert.equal(publicNow.characters[0].age, "Early thirties"); assert.equal(publicNow.characters[0].gender, "Woman");
  assert.equal(publicNow.characters[0].profile, undefined);
  assert.equal(JSON.parse(h.variables.get(`chat:${CHAT_KEYS.legacyPublic}`)).characters[0].age, undefined);
  assert.match(h.variables.get(`chat:${CHAT_KEYS.visual}`), /AGE: Early thirties; GENDER: Woman/);
  assert.ok(!h.variables.get(`chat:${CHAT_KEYS.visual}`).includes("Lantern Guild"));
  const restarted = createStoryEngine(h.api); await restarted.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 3); assert.deepEqual((await restarted.loadStore("chat")).current, after.current);
  await restarted.handleFrontend({ type: "story_fill_identity", chatId: "chat" }, "owner");
  assert.equal(h.requests.length, 3); assert.equal(h.sent.at(-1).payload.ok, true);
});

test("v2 saves migrate locally and explicit identity filling survives portable setup import and forks", async () => {
  const h = harness(); await h.select();
  const path = h.engine.pathFor("chat"), saved = h.files.get(path), revision = saved.revision;
  for (const key of ["baseline", "current"]) saved[key] = legacyTrackerState(saved[key], 2);
  saved.initialSetup.state = legacyTrackerState(saved.initialSetup.state, 2);
  for (const checkpoint of Object.values(saved.checkpoints)) checkpoint.state = legacyTrackerState(checkpoint.state, 2);
  const restarted = createStoryEngine(h.api); await restarted.handleFrontend({ type: "story_get_status", chatId: "chat" }, "owner");
  assert.equal(h.requests.length, 1); assert.equal((await restarted.loadStore("chat")).revision, revision);
  assert.equal((await restarted.loadStore("chat")).current.characters[0].profile.age, "Unknown");
  h.setResponse(async () => ({ content: JSON.stringify({ schemaVersion: 3, world: { action: "preserve", changes: [] },
    characters: [{ id: "c1", action: "update", changes: [{ field: "profile.age", value: "Ageless" }, { field: "profile.gender", value: "Genderless" }] }],
    relationships: [], places: [], objectives: [] }) }));
  await restarted.handleFrontend({ type: "story_fill_identity", chatId: "chat" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 2);
  await restarted.handleFrontend({ type: "story_export_setup", chatId: "chat" }, "owner");
  const exported = h.sent.at(-1).payload; assert.equal(exported.ok, true);
  const portable = JSON.parse(exported.fileText); assert.equal(portable.initialState.schemaVersion, 3);
  assert.equal(portable.initialState.characters[0].profile.age, "Ageless");
  await restarted.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: exported.fileText }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 2);
  const original = h.messages.get("chat"), map = Object.fromEntries(original.map((message, index) => [message.id, `fork-${index}`]));
  h.messages.set("fork", original.map(message => ({ ...structuredClone(message), id: map[message.id] })));
  h.chats.set("fork", { id: "fork", character_id: "ada" });
  await restarted.inheritFork({ sourceChatId: "chat", forkedChatId: "fork", forkedAtMessageId: original.at(-1).id, messageIdMap: map }, "owner");
  const fork = await restarted.loadStore("fork");
  assert.equal(fork.current.characters[0].profile.age, "Ageless"); assert.equal(fork.current.characters[0].profile.gender, "Genderless");
  assert.equal(h.requests.length, 2);
});

test("identity fill keeps unsupported values Unknown and discards a response when the chat changes", async () => {
  const h = harness(); await h.select(); const before = await h.engine.loadStore("chat");
  h.setResponse(async () => ({ content: JSON.stringify({ schemaVersion: 3, world: { action: "preserve", changes: [] },
    characters: [], relationships: [], places: [], objectives: [] }) }));
  await h.engine.handleFrontend({ type: "story_fill_identity", chatId: "chat" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.match(h.sent.at(-1).payload.message, /Unknown values were preserved/);
  assert.deepEqual((await h.engine.loadStore("chat")).current, before.current); assert.equal((await h.engine.loadStore("chat")).revision, before.revision);
  h.setResponse(async () => {
    h.messages.get("chat").push({ id: "racing-user", role: "user", content: "Wait." });
    return { content: JSON.stringify({ schemaVersion: 3, world: { action: "preserve", changes: [] }, characters: [{ id: "c1", action: "update", changes: [{ field: "profile.age", value: "30" }] }], relationships: [], places: [], objectives: [] }) };
  });
  await h.engine.handleFrontend({ type: "story_fill_identity", chatId: "chat" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, false); assert.match(h.sent.at(-1).payload.message, /changed during extraction/);
  assert.deepEqual((await h.engine.loadStore("chat")).current, before.current);
});

test("identity extraction cannot commit after a source edit or navigation away", async () => {
  for (const mutation of ["source", "navigation"]) {
    const h = harness(); await h.select(); const before = await h.engine.loadStore("chat");
    h.setResponse(async () => {
      if (mutation === "source") h.cards.get("ada").description += " A newly edited fact.";
      else await h.engine.handleFrontend({ type: "story_get_status", chatId: null }, "owner");
      return { content: JSON.stringify({ schemaVersion: 3, world: { action: "preserve", changes: [] },
        characters: [{ id: "c1", action: "update", changes: [{ field: "profile.age", value: "30" }] }], relationships: [], places: [], objectives: [] }) };
    });
    await h.engine.handleFrontend({ type: "story_fill_identity", chatId: "chat" }, "owner");
    assert.equal(h.sent.at(-1).payload.ok, false); assert.match(h.sent.at(-1).payload.message, /changed during extraction/);
    assert.deepEqual((await h.engine.loadStore("chat")).current, before.current);
    assert.equal((await h.engine.status("chat", "owner")).processing, false);
  }
});

test("contextual starting conditions persist in mirrors, restart and portable setups without rerolling", async () => {
  const h = harness();
  h.cards.get("ada").scenario = "A contemporary café patio in San Diego, California; no date, time or weather is established.";
  h.cards.get("ada").first_mes = h.messages.get("chat")[0].content = "Ada waits on the café patio, wearing a blue coat.";
  const original = structuredClone(h.messages.get("chat"));
  const chosen = fixtureState();
  Object.assign(chosen.world, { location: "Café patio, San Diego",
    weather: "Partly cloudy; dry conditions and a light coastal breeze. The patio is sheltered from the wind." });
  h.setResponse(async () => {
    const { values } = [...h.files.values()].find(store => store?.initialWorldDefaults).initialWorldDefaults;
    // An unconstrained opening reuses the saved clock anchors while enriching missing weather.
    Object.assign(chosen.world, { date: values.date, time: values.time });
    return { content: JSON.stringify(modelOutput(chosen, { initialize: true })) };
  });
  await h.select();
  const initial = await h.engine.loadStore("chat");
  assert.equal(h.requests.length, 1); assert.equal(initial.fillMissingSceneDetails, false);
  for (const field of ["date", "time", "weather"]) assert.equal(initial.current.world[field], chosen.world[field]);
  const visual = h.variables.get(`chat:${CHAT_KEYS.visual}`);
  assert.ok(visual.includes(`WHEN: ${formatStoryClockValue("date", chosen.world.date)}; ${formatStoryClockValue("time", chosen.world.time)}`));
  assert.ok(visual.includes(chosen.world.weather));
  assert.equal(JSON.parse(h.variables.get(`chat:${CHAT_KEYS.public}`)).world.weather, chosen.world.weather);
  const restarted = createStoryEngine(h.api);
  await restarted.schedule("chat", { reprocess: true }, "owner");
  assert.equal(h.requests.length, 1);
  await restarted.handleFrontend({ type: "story_export_setup", chatId: "chat", requestId: "context-export" }, "owner");
  const exported = h.sent.at(-1).payload; assert.equal(exported.ok, true);
  await restarted.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: exported.fileText, requestId: "context-import" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 1);
  for (const field of ["date", "time", "weather"]) assert.equal((await restarted.loadStore("chat")).current.world[field], chosen.world[field]);
  const prompt = await restarted.intercept([{ role: "user", content: "I nod." }], { chatId: "chat", userId: "owner" });
  assert.match(prompt.messages[0].content, /brief gestures may leave the displayed minute unchanged/i);
  assert.match(prompt.messages[0].content, /Do not use a fixed advance per reply/);
  assert.ok(prompt.messages[0].content.includes(chosen.world.weather));
  // Import adds its confirmation; the original selected opening is preserved.
  assert.deepEqual(h.messages.get("chat").slice(0, original.length), original);
});

test("v1.5.3 failed setup evidence can restore a preview locally without running generation", async () => {
  const h = harness(), response = modelOutput(undefined, { initialize: true }); response.world.sceneStatus = "in_progress";
  h.setResponse(async () => ({ content: JSON.stringify(response), finish_reason: "stop" })); await h.select();
  const path = [...h.files.keys()].find(key => key.startsWith("chats/"));
  h.files.get(path).setupDraft = null;
  const restarted = createStoryEngine(h.api), status = await restarted.status("chat", "owner");
  assert.equal(h.requests.length, 2); assert.equal(status.setupPreview.snapshot.characters[0].name, "Ada");
  assert.equal(status.setupPreview.snapshot.world.sceneStatus, "Unavailable — needs repair");
  h.files.get(path).trackerDiagnostics.attempts.forEach(attempt => { attempt.excerpt = '{"schemaVersion":2,"world":'; });
  assert.equal((await restarted.status("chat", "owner")).setupPreview, null);
});

test("upgrading the tracker contract releases an old rejection pause without replaying valid checkpoints", async () => {
  const h = harness(); await h.select(); h.addTurn("Ada nods."); h.setResponse(async () => ({ content: "invalid" }));
  await h.engine.schedule("chat", {}, "owner");
  const path = [...h.files.keys()].find(key => key.startsWith("chats/")), store = h.files.get(path);
  const turns = listEligibleTurns(h.messages.get("chat")), turn = turns.at(-1);
  store.rejectedTurn.signature = fingerprint({ contract: 1, userId: "owner", epoch: store.epoch, sources: store.sourceFingerprint,
    previousState: store.baseline, turn: turn.fingerprint, focusCharacterId: turn.assistant.character_id,
    connectionId: "", outputMode: "auto", maxTokens: 6144, timeoutMs: 120000 });
  h.setResponse(null); const restarted = createStoryEngine(h.api);
  await restarted.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 4); assert.equal((await restarted.loadStore("chat")).lastError, "");
});

test("automatic starting outfits persist on reopen and export while turns update clothing and place state", async () => {
  const h = harness();
  h.cards.get("ada").first_mes = h.messages.get("chat")[0].content = "Ada waits beneath the platform clock.";
  await h.select();
  assert.match(h.requests[0].messages[0].content, /Fill missing scene details is OFF/);
  assert.match(h.requests[0].messages[0].content, /Independently of the checkbox/);
  assert.equal((await h.engine.loadStore("chat")).current.characters[0].visible.dressAndLayers, "Blue coat");
  await h.open(); assert.equal(h.requests.length, 1);
  h.addTurn("Coat removed. Door opened."); await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 2); assert.ok(!h.requests[1].messages[0].content.includes("INITIAL SCENE DEFAULTS"));
  const store = await h.engine.loadStore("chat"); assert.equal(store.current.characters[0].visible.dressAndLayers, "White shirt; blue coat on bench"); assert.equal(store.current.places[0].currentState, "Side door open");
  await h.engine.handleFrontend({ type: "story_export_setup", chatId: "chat", requestId: "export" }, "owner");
  const result = h.sent.at(-1).payload; assert.equal(result.ok, true);
  const portable = JSON.parse(result.fileText); assert.equal(portable.initialState.characters[0].visible.dressAndLayers, "Blue coat"); assert.ok(!result.fileText.includes('"a1"'));
});
test("scene filling choice survives interrupted setup and saved defaults are reused on reopen, reprocess and import", async () => {
  const h = harness(); await h.open();
  assert.equal((await h.engine.status("chat", "owner")).fillMissingSceneDetails, false);
  h.setResponse(async () => ({ content: "invalid" }));
  await h.engine.handleFrontend({ type: "story_create_setup", chatId: "chat", requestId: "create-details", fillMissingSceneDetails: true }, "owner");
  assert.equal(h.requests.length, 2); assert.equal((await h.engine.loadStore("chat")).fillMissingSceneDetails, true);
  h.setResponse(async request => {
    assert.match(request.messages[0].content, /Fill missing scene details is ON/);
    const output = modelOutput(undefined, { initialize: true }); output.world.date = "Day 1, late autumn";
    output.world.immediateContext = "Quiet light beneath the awning";
    return { content: JSON.stringify(output) };
  });
  const restarted = createStoryEngine(h.api); await restarted.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 2); assert.equal((await restarted.loadStore("chat")).setupProgress.status, "failed");
  await restarted.handleFrontend({ type: "story_get_status", chatId: "chat" }, "owner");
  await restarted.handleFrontend({ type: "story_create_setup", chatId: "chat", requestId: "retry", fillMissingSceneDetails: true }, "owner");
  const saved = await restarted.loadStore("chat"); assert.equal(h.requests.length, 3); assert.equal(saved.lastError, "");
  assert.equal(saved.current.world.date, "Day 1, late autumn");
  await restarted.handleFrontend({ type: "story_get_status", chatId: "chat" }, "owner");
  await restarted.schedule("chat", { reprocess: true }, "owner");
  assert.equal(h.requests.length, 3); assert.deepEqual((await restarted.loadStore("chat")).current, saved.current);
  await restarted.handleFrontend({ type: "story_export_setup", chatId: "chat", requestId: "export-defaults" }, "owner");
  const fileText = h.sent.at(-1).payload.fileText;
  assert.equal(JSON.parse(fileText).initialState.world.date, "Day 1, late autumn");
  await restarted.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText, requestId: "import-defaults" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 3);
  assert.equal((await restarted.loadStore("chat")).current.world.immediateContext, "Quiet light beneath the awning");
});
test("editing and swiping a turn rebuild only the changed tail", async () => {
  const h = harness(); await h.select(); h.addTurn("Coat removed."); await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 2);
  h.messages.get("chat").at(-1).content = "Door opened."; h.messages.get("chat").at(-1).swipe_id = 1;
  await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 3); const store = await h.engine.loadStore("chat");
  assert.equal(store.current.characters[0].visible.dressAndLayers, "Blue coat"); assert.ok(!store.checkpoints["a1::0"]); assert.ok(store.checkpoints["a1::1"]);
});
test("failed tracker retains only the last valid branch prefix and injection remains available", async () => {
  const h = harness(); await h.select(); h.addTurn("Coat removed."); await h.engine.schedule("chat", {}, "owner");
  h.messages.get("chat").at(-1).content = "Changed event."; h.setResponse(async () => ({ content: "invalid" }));
  await h.engine.schedule("chat", {}, "owner"); const store = await h.engine.loadStore("chat");
  assert.equal(store.current.characters[0].visible.dressAndLayers, "Blue coat"); assert.ok(store.lastError); assert.ok(!store.checkpoints["a1::0"]);
  const result = await h.engine.intercept([{ role: "user", content: "Next" }], { chatId: "chat", userId: "owner" });
  assert.ok(result.messages[0].content.includes("using last valid checkpoint"));
});

test("partial turns persist, allow later tracking, and retry only unresolved fields before replay", async () => {
  const h = harness(), initial = fixtureState();
  const mira = structuredClone(initial.characters[0]); mira.id = "npc:mira"; mira.role = "npc"; mira.name = "Mira";
  initial.characters.push(mira); initial.relationships.push({ id: "rel:mira", fromId: "char:ada", toId: mira.id,
    publicStatus: "Colleagues", privateState: "Cautious trust", boundaryOrConcern: "Unknown", sourceMessageId: "card-baseline" });
  h.setResponse(async () => ({ content: JSON.stringify(modelOutput(initial, { initialize: true })) })); await h.select();
  h.addTurn("Ada and Mira talk while Ada removes her coat.");
  const bad = { schemaVersion: 3, world: { action: "update", changes: [{ field: "time", value: "21:05" }] },
    characters: [{ id: "c1", action: "update", changes: [{ field: "profile.age", value: "Early thirties" }, { field: "visible.dressAndLayers", value: "White shirt; coat on bench" }] }],
    relationships: [{ id: "r1", action: "update", changes: [{ field: "privateState", value: "" }] }], places: [], objectives: [] };
  h.setResponse(async () => ({ content: JSON.stringify(bad) })); await h.engine.schedule("chat", {}, "owner");
  const partial = await h.engine.loadStore("chat"); assert.equal(partial.lastError, ""); assert.equal(partial.rejectedTurn, null);
  assert.equal(partial.current.characters[0].profile.age, "Early thirties"); assert.equal(partial.current.characters[0].visible.dressAndLayers, "White shirt; coat on bench");
  assert.equal(partial.current.relationships[0].privateState, "Cautious trust"); assert.ok(partial.checkpoints["a1::0"].partial);
  const status = await h.engine.status("chat", "owner"); assert.equal(status.code, "partial"); assert.equal(status.trackerInfo.retryPaused, false);
  assert.match(status.partialUpdates[0].fields[0], /privateState/); assert.equal(partial.trackerMetrics.partial, 1);
  h.addTurn("A later conversation between Ada and Mira.", "a2");
  const later = { schemaVersion: 3, world: { action: "update", changes: [{ field: "time", value: "22:00" }] }, characters: [], relationships: [], places: [], objectives: [] };
  h.setResponse(async () => ({ content: JSON.stringify(later) })); await h.engine.schedule("chat", {}, "owner");
  assert.equal((await h.engine.loadStore("chat")).lastTrackedMessageId, "a2");
  const restarted = createStoryEngine(h.api); await restarted.handleFrontend({ type: "story_get_status", chatId: "chat" }, "owner");
  assert.equal(h.requests.length, 4); assert.equal((await restarted.status("chat", "owner")).code, "partial");
  const copied = h.messages.get("chat").slice(0, h.messages.get("chat").findIndex(message => message.id === "a1") + 1);
  const map = Object.fromEntries(copied.map(message => [message.id, `fork-${message.id}`]));
  h.messages.set("fork", copied.map(message => ({ ...structuredClone(message), id: map[message.id] }))); h.chats.set("fork", { id: "fork", character_id: "ada" });
  await restarted.inheritFork({ sourceChatId: "chat", forkedChatId: "fork", forkedAtMessageId: "a1", messageIdMap: map }, "owner");
  const fork = await restarted.loadStore("fork"); assert.equal(fork.checkpoints["fork-a1::0"].partial.sourceMessageId, "fork-a1");
  assert.equal((await restarted.status("fork", "owner")).code, "partial"); assert.equal(h.requests.length, 4);
  h.setResponse(async request => {
    if (request.messages[1].content.startsWith("RETRY INCOMPLETE")) return { content: JSON.stringify({ ...bad,
      relationships: [{ id: "r1", action: "update", changes: [{ field: "privateState", value: "Relaxed trust" }] }],
      characters: [{ id: "c1", action: "update", changes: [{ field: "profile.age", value: "99" }, { field: "visible.dressAndLayers", value: "Wrong coat" }] }] }) };
    return { content: JSON.stringify(later) };
  });
  await restarted.handleFrontend({ type: "story_retry_partial", chatId: "chat" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 6);
  const fixed = await restarted.loadStore("chat"); assert.equal(fixed.current.relationships[0].privateState, "Relaxed trust");
  assert.equal(fixed.current.characters[0].profile.age, "Early thirties"); assert.equal(fixed.current.characters[0].visible.dressAndLayers, "White shirt; coat on bench");
  assert.equal(fixed.current.world.time, "22:00"); assert.equal((await restarted.status("chat", "owner")).code, "active");
  assert.equal(fixed.checkpoints["a1::0"].partial, null);
});

test("optional setup failures save profiles while malformed retry cannot remove an accepted partial checkpoint", async () => {
  const h = harness(), initial = fixtureState();
  const mira = structuredClone(initial.characters[0]); mira.id = "npc:mira"; mira.role = "npc"; mira.name = "Mira";
  initial.characters.push(mira); initial.relationships.push({ id: "rel:mira", fromId: "char:ada", toId: mira.id,
    publicStatus: "Colleagues", privateState: "", boundaryOrConcern: "Unknown", sourceMessageId: "card-baseline" });
  h.setResponse(async () => ({ content: JSON.stringify(modelOutput(initial, { initialize: true })) })); await h.select();
  const saved = await h.engine.loadStore("chat"); assert.ok(saved.baseline); assert.ok(saved.baselinePartial); assert.equal(saved.current.relationships[0].privateState, "Unknown");
  assert.equal((await h.engine.status("chat", "owner")).code, "partial");
  h.setResponse(async () => ({ content: "unreadable" })); await h.engine.handleFrontend({ type: "story_retry_partial", chatId: "chat" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, false); const failed = await h.engine.loadStore("chat");
  assert.deepEqual(failed.current, saved.current); assert.deepEqual(failed.baselinePartial, saved.baselinePartial); assert.equal(failed.rejectedTurn, null);
  h.setResponse(async () => ({ content: JSON.stringify({ schemaVersion: 3, world: { action: "preserve", changes: [] }, characters: [],
    relationships: [{ id: "r1", action: "update", changes: [{ field: "privateState", value: "Cautious trust" }] }], places: [], objectives: [] }) }));
  await h.engine.handleFrontend({ type: "story_retry_partial", chatId: "chat" }, "owner");
  const fixed = await h.engine.loadStore("chat"); assert.equal(fixed.current.relationships[0].privateState, "Cautious trust");
  assert.equal(fixed.baselinePartial, null); assert.equal((await h.engine.status("chat", "owner")).code, "active");
  assert.equal(fixed.initialSetup.state.relationships[0].privateState, "Cautious trust");
});

test("rejected turns pause automatic calls across events and restart until explicitly reprocessed", async () => {
  const h = harness(); await h.select(); const initial = await h.engine.loadStore("chat");
  h.addTurn("Ada nods."); h.setResponse(async () => ({ content: "invalid" }));
  await h.engine.schedule("chat", {}, "owner");
  const failed = await h.engine.loadStore("chat");
  assert.equal(h.requests.length, 3); assert.ok(failed.rejectedTurn);
  assert.match(failed.lastError, /Automatic retries are paused/);
  assert.deepEqual(failed.current, initial.current); assert.equal(failed.revision, initial.revision);
  await h.events.get("MESSAGE_SENT")({ chatId: "chat" }, "owner");
  await h.events.get("CHAT_SWITCHED")({ chatId: "chat" }, "owner");
  h.addTurn("Ada waits.", "a2");
  const prompt = await h.engine.intercept([{ role: "user", content: "Next" }], { chatId: "chat", userId: "owner" });
  assert.ok(prompt.messages[0].content.includes("using last valid checkpoint"));
  const restarted = createStoryEngine(h.api);
  await restarted.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 3); assert.equal((await restarted.loadStore("chat")).revision, initial.revision);
  h.setResponse(null);
  await restarted.schedule("chat", { reprocess: true }, "owner");
  const recovered = await restarted.loadStore("chat");
  assert.equal(h.requests.length, 5); assert.equal(recovered.lastError, ""); assert.equal(recovered.rejectedTurn, null);
  assert.ok(recovered.checkpoints["a1::0"] && recovered.checkpoints["a2::0"]);
});

test("edits and tracker setting changes release rejection pauses while widget changes do not", async () => {
  for (const change of ["edit", "config"]) {
    const h = harness(); await h.select(); h.addTurn("Ada nods.");
    h.setResponse(async () => ({ content: "invalid" })); await h.engine.schedule("chat", {}, "owner");
    assert.equal(h.requests.length, 3);
    await h.engine.handleFrontend({ type: "story_set_widget_visibility", chatId: "chat", showStatusWidget: false }, "owner");
    assert.equal(h.requests.length, 3);
    h.setResponse(null);
    if (change === "edit") {
      h.messages.get("chat").find(message => message.id === "a1").content = "Ada opens the door.";
      await h.engine.schedule("chat", {}, "owner");
    } else await h.engine.handleFrontend({ type: "story_save_config", chatId: "chat", config: { maxTokens: 8192 } }, "owner");
    const store = await h.engine.loadStore("chat");
    assert.equal(h.requests.length, 4); assert.equal(store.lastError, ""); assert.equal(store.rejectedTurn, null);
  }
});

test("transient provider failures remain eligible for automatic retry", async () => {
  const h = harness(); await h.select(); h.addTurn("Ada nods.");
  h.setResponse(async () => { throw new Error("Provider unavailable"); });
  await h.engine.schedule("chat", {}, "owner"); await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 3); assert.equal((await h.engine.loadStore("chat")).rejectedTurn, null);
  h.setResponse(null); await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 4); assert.equal((await h.engine.loadStore("chat")).lastError, "");
});
test("stale tracker output is discarded when the selected turn changes during generation", async () => {
  const h = harness(); await h.select(); h.addTurn("Coat removed.");
  h.setResponse(async () => { h.messages.get("chat").at(-1).content = "New swipe during tracking"; return { content: JSON.stringify(modelOutput()) }; });
  await h.engine.schedule("chat", {}, "owner"); const store = await h.engine.loadStore("chat");
  assert.match(store.lastError, /branch changed/); assert.ok(!store.checkpoints["a1::0"]);
});
test("opening edits rebuild the baseline and card edits require an explicit profile refresh", async () => {
  const h = harness(); await h.select(); h.cards.get("ada").description = "Ada now has a corrected background.";
  await h.engine.schedule("chat", {}, "owner"); assert.equal(h.requests.length, 1); assert.ok((await h.engine.loadStore("chat")).pendingCardFingerprint);
  await h.engine.schedule("chat", { refreshCards: true }, "owner"); assert.equal(h.requests.length, 2); assert.equal((await h.engine.loadStore("chat")).sources.cards[0].description, h.cards.get("ada").description);
  h.messages.get("chat")[0].content = "A new selected opening.";
  await h.engine.schedule("chat", {}, "owner"); assert.equal(h.requests.length, 3); assert.equal((await h.engine.loadStore("chat")).sources.selectedOpening, "A new selected opening.");
});
test("Home remains idle and background message events cannot resurrect old chat UI", async () => {
  const h = harness(); await h.select(); await h.engine.handleFrontend({ type: "story_get_status", chatId: null }, "owner");
  const count = h.sent.length; await h.events.get("MESSAGE_SENT")({ chatId: "chat" }, "owner"); assert.equal(h.sent.length, count);
  const publicStatus = await h.engine.status("chat", "owner", false); assert.ok(!Object.hasOwn(publicStatus, "privateState"));
  assert.ok((await h.engine.status("chat", "owner", true)).privateState);
});
test("specialized cards never initialize, mirror or inject competing generic state", async () => {
  const h = harness(); h.cards.get("ada").description = "Storyteller v1.6.0"; await h.select();
  assert.equal(h.requests.length, 0); assert.ok((await h.engine.loadStore("chat")).blocked);
  const prompt = [{ role: "user", content: "Next" }]; assert.deepEqual(await h.engine.intercept(prompt, { chatId: "chat", userId: "owner" }), prompt);
});
test("fork inherits exactly the copied prefix and remaps source ids without replay", async () => {
  const h = harness(); await h.select(); h.addTurn("Coat removed."); await h.engine.schedule("chat", {}, "owner");
  h.addTurn("Door opened.", "a2"); await h.engine.schedule("chat", {}, "owner");
  const copied = h.messages.get("chat").slice(0, h.messages.get("chat").findIndex(message => message.id === "a1") + 1), map = Object.fromEntries(copied.map(message => [message.id, `fork-${message.id}`]));
  h.messages.set("fork", copied.map(message => ({ ...message, id: map[message.id] }))); h.chats.set("fork", { id: "fork", character_id: "ada" });
  const requests = h.requests.length;
  await h.events.get("CHAT_FORKED")({ sourceChatId: "chat", forkedChatId: "fork", forkedAtMessageId: "a1", messageIdMap: map }, "owner");
  assert.equal(h.requests.length, requests); const store = await h.engine.loadStore("fork");
  assert.equal(store.current.characters[0].sourceMessageId, "fork-a1"); assert.equal(store.current.places[0].currentState, "Side door locked"); assert.ok(!store.checkpoints["fork-a2::0"]);
});
test("portable import validates before writing and recovers from its metadata anchor", async () => {
  const h = harness(); await h.select();
  const messageCount = h.messages.get("chat").length;
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: "{}", requestId: "bad" }, "owner"); assert.equal(h.messages.get("chat").length, messageCount); assert.equal(h.sent.at(-1).payload.ok, false);
  const setup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: remapStateSources(fixtureState(), new Map(), "initial-setup") };
  const count = h.requests.length;
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: JSON.stringify(setup), requestId: "import" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, count);
  const anchor = h.messages.get("chat").at(-1); assert.equal(anchor.content, IMPORT_LOADED_TEXT);
  h.files.delete(h.engine.pathFor("chat")); await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, count); assert.equal((await h.engine.loadStore("chat")).current.characters[0].sourceMessageId, anchor.id);
  assert.equal((await h.engine.status("chat", "owner")).canBegin, true);
});
test("cleanup rechecks chat existence and deleted chats cannot recreate tracking files", async () => {
  const h = harness(); await h.select(); h.chats.delete("chat");
  await h.engine.handleFrontend({ type: "story_scan_cleanup" }, "owner"); const scan = h.sent.at(-1).payload; assert.equal(scan.count, 1);
  h.chats.set("chat", { id: "chat", character_id: "ada" });
  await h.engine.handleFrontend({ type: "story_cleanup_unused", token: scan.token }, "owner"); assert.ok(h.files.has(h.engine.pathFor("chat")));
  await h.events.get("CHAT_DELETED")({ id: "chat" }); assert.ok(!h.files.has(h.engine.pathFor("chat")));
  await h.engine.schedule("chat", {}, "owner"); assert.ok(!h.files.has(h.engine.pathFor("chat")));
});

test("damaged saved state rebuilds and an edited import anchor cannot export stale imported state", async () => {
  const h = harness(); await h.select();
  h.files.get(h.engine.pathFor("chat")).current.world.time = 5;
  await h.engine.schedule("chat", {}, "owner"); assert.equal(h.requests.length, 2); assert.equal((await h.engine.loadStore("chat")).current.world.time, "00:00");
  const setup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: remapStateSources(fixtureState(), new Map(), "initial-setup") };
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: JSON.stringify(setup), requestId: "import" }, "owner");
  h.messages.get("chat").at(-1).content = "Edited confirmation";
  await h.engine.handleFrontend({ type: "story_export_setup", chatId: "chat", requestId: "export" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, false); assert.match(h.sent.at(-1).payload.message, /anchor/);
});

test("old saved states and portable v1 setups upgrade without tracker regeneration", async () => {
  const h = harness(); await h.select();
  const store = h.files.get(h.engine.pathFor("chat"));
  store.baseline = legacyTrackerState(store.baseline); store.current = legacyTrackerState(store.current); store.initialSetup.state = legacyTrackerState(store.initialSetup.state);
  for (const checkpoint of Object.values(store.checkpoints)) checkpoint.state = legacyTrackerState(checkpoint.state);
  const count = h.requests.length, revision = store.revision;
  await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, count); assert.equal((await h.engine.loadStore("chat")).revision, revision);
  assert.equal(JSON.parse(h.variables.get(`chat:${CHAT_KEYS.state}`)).schemaVersion, 3);
  assert.equal(JSON.parse(h.variables.get(`chat:${CHAT_KEYS.legacyState}`)).schemaVersion, 1);
  const legacySetup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: remapStateSources(legacyTrackerState(fixtureState()), new Map(), "initial-setup") };
  legacySetup.initialState = legacyTrackerState(legacySetup.initialState);
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: JSON.stringify(legacySetup), requestId: "legacy-import" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, count); assert.equal((await h.engine.loadStore("chat")).current.schemaVersion, 3);
});

test("explicit imported-profile refresh fills missing stable fields without altering recorded starting conditions", async () => {
  const h = harness(); await h.select();
  const initial = legacyTrackerState(remapStateSources(fixtureState(), new Map(), "initial-setup"));
  const setup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: initial };
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: JSON.stringify(setup), requestId: "import" }, "owner");
  h.setResponse(async () => {
    const proposed = modelOutput(); proposed.characters[0].profile.boundaries = "Keep the private locker closed"; proposed.characters[0].profile.relationshipContext = "Former colleague of the stationmaster";
    proposed.characters[0].visible.dressAndLayers = "Invented replacement outfit"; proposed.world.time = "Changed time";
    return { content: JSON.stringify(proposed) };
  });
  const calls = h.requests.length; await h.engine.schedule("chat", { refreshCards: true }, "owner");
  const store = await h.engine.loadStore("chat"); assert.equal(h.requests.length, calls + 1);
  assert.equal(store.current.characters[0].profile.boundaries, "Keep the private locker closed"); assert.equal(store.current.characters[0].profile.relationshipContext, "Former colleague of the stationmaster");
  assert.equal(store.current.characters[0].visible.dressAndLayers, "Blue coat"); assert.equal(store.current.world.time, "Midnight");
  assert.ok(h.requests.at(-1).messages[1].content.includes("ORIGINAL CARD SOURCES"));
});

test("GUID-backed saves inject only aliases and rejected alias typos cannot commit duplicate characters", async () => {
  const h = harness(), guid = "12345678-1234-4321-8765-123456789abc";
  const sources = structuredClone(SOURCES); sources.cards[0].id = guid;
  h.cards.delete("ada"); h.cards.set(guid, sources.cards[0]); h.chats.get("chat").character_id = guid;
  const proposed = fixtureState(); proposed.characters[0].id = `char:${guid}`;
  h.setResponse(async () => ({ content: JSON.stringify(modelOutput(proposed, { sources, initialize: true })) }));
  await h.select();
  const initial = await h.engine.loadStore("chat"); assert.equal(initial.current.characters[0].id, `char:${guid}`);
  const injection = await h.engine.intercept([{ role: "user", content: "Continue" }], { chatId: "chat", userId: "owner" });
  assert.ok(injection.messages[0].content.includes('CHARACTER c1: Ada')); assert.ok(!injection.messages[0].content.includes(guid));
  assert.ok(!h.requests[0].messages.map(message => message.content).join("\n").includes(guid));
  h.addTurn("Ada removes the coat.");
  h.setResponse(async () => {
    const invalid = modelOutput(proposed, { sources }); invalid.characters[0].id = "c99"; invalid.characters[0].visible.dressAndLayers = "Coat removed";
    return { content: JSON.stringify(invalid) };
  });
  await h.engine.schedule("chat", {}, "owner");
  const failed = await h.engine.loadStore("chat");
  assert.equal(h.requests.length, 3); assert.equal(failed.lastError, ""); assert.ok(failed.checkpoints["a1::0"].partial);
  assert.deepEqual(failed.current, initial.current); assert.equal(failed.current.characters.length, 1);
  assert.equal(failed.revision, initial.revision + 1);
  assert.ok(h.variables.get(`chat:${CHAT_KEYS.state}`).includes(guid));
});

test("card setup preserves the opening, saves private/public mirrors and rechecks without generation", async () => {
  const h = harness(); let release, started;
  const original = structuredClone(h.messages.get("chat")); await h.open();
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, "a0");
  const gate = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { started = resolve; });
  h.setResponse(async () => { started(); await gate; return { content: JSON.stringify(modelOutput(undefined, { initialize: true })) }; });
  const pending = h.select(); await observed;
  assert.deepEqual(h.messages.get("chat"), original);
  assert.equal((await h.engine.loadStore("chat")).current, null);
  release(); await pending;
  assert.deepEqual(h.noticeDeletes, []); assert.deepEqual(h.messages.get("chat"), original);
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, null); assert.equal(h.requests.length, 1);
  assert.deepEqual(Object.keys((await h.engine.loadStore("chat")).checkpoints), ["a0::0"]);
  const store = await h.engine.loadStore("chat"); assert.ok(store.initialSetup);
  assert.equal(store.current.characters[0].visible.dressAndLayers, "Blue coat");
  assert.ok(h.variables.get(`chat:${CHAT_KEYS.state}`).includes("Lantern Guild"));
  assert.ok(!h.variables.get(`chat:${CHAT_KEYS.public}`).includes("Lantern Guild"));
  const visual = h.variables.get(`chat:${CHAT_KEYS.visual}`);
  assert.match(visual, /CURRENT SCENE\nWHEN: October 13; 12:00 AM \(Midnight\)/);
  assert.match(visual, /STABLE APPEARANCE: FACE: Angular; EYES: Brown/);
  assert.match(visual, /DRESS & LAYERS: Blue coat/);
  for (const secret of ["Lantern Guild", "Hidden tunnel", "Knows the signal is faulty", "Repair the signal", "sourceMessageId"]) assert.ok(!visual.includes(secret));
  assert.equal((await h.engine.status("chat", "owner")).canImport, true);
  await h.engine.schedule("chat", {}, "owner");
  const rechecked = await h.engine.loadStore("chat");
  assert.equal(h.requests.length, 1); assert.equal(rechecked.revision, store.revision); assert.equal(rechecked.lastRevisionAt, store.lastRevisionAt);
  h.setResponse(null); h.addTurn("Ada nods."); await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 2);
  assert.equal(listEligibleTurns(h.messages.get("chat")).length, 2);
});

test("story clock updates and visual macros follow committed turns without extra generation", async () => {
  const h = harness();
  h.setResponse(async request => {
    assert.match(request.messages[0].content, /YYYY-MM-DD/);
    assert.match(request.messages[0].content, /24-hour HH:mm/);
    assert.match(request.messages[0].content, /midnight, month and year rollovers/);
    assert.match(request.messages[0].content, /Observation, analysis and real waiting do not advance time/);
    const proposed = modelOutput(undefined, { initialize: true });
    Object.assign(proposed.world, { date: "2031-12-31 (Winter)", time: "11:50 pm (Late night)" });
    return { content: JSON.stringify(proposed) };
  });
  await h.select(); assert.equal(h.requests.length, 1);
  assert.match(h.variables.get(`chat:${CHAT_KEYS.visual}`), /WHEN: December 31 \(Winter\); 11:50 PM \(Late night\)/);
  h.addTurn("Twenty minutes later, Ada removes her coat.");
  h.setResponse(async request => {
    assert.ok(request.messages[1].content.includes('"date":"2031-12-31 (Winter)"'));
    assert.ok(request.messages[1].content.includes('"time":"23:50 (Late night)"'));
    return { content: JSON.stringify({ schemaVersion: 3, world: { action: "update", changes: [{ field: "date", value: "2032-1-1 (Winter)" }, { field: "time", value: "12:10 am" }] },
      characters: [{ id: "c1", action: "update", changes: [{ field: "visible.dressAndLayers", value: "White shirt; coat on bench" }] }], relationships: [], places: [], objectives: [] }) };
  });
  await h.engine.schedule("chat", {}, "owner");
  const current = (await h.engine.loadStore("chat")).current;
  assert.equal(current.world.date, "2032-01-01 (Winter)"); assert.equal(current.world.time, "00:10");
  assert.match(h.variables.get(`chat:${CHAT_KEYS.visual}`), /WHEN: January 1 \(Winter\); 12:10 AM \(Late night\)/);
  assert.match(h.variables.get(`chat:${CHAT_KEYS.visual}`), /DRESS & LAYERS: White shirt; coat on bench/);
  const prompt = await h.engine.intercept([{ role: "user", content: "Continue" }], { chatId: "chat", userId: "owner" });
  assert.match(prompt.messages[0].content, /WHEN: January 1 \(Winter\); 12:10 AM \(Late night\)/);
  assert.equal(h.requests.length, 2);
});

test("failed initialization keeps the opening target available for retry without posting diagnostics", async () => {
  const h = harness(); h.setResponse(async () => { throw new Error("PRIVATE_DIAGNOSTIC_WITH_SECRET"); });
  const original = structuredClone(h.messages.get("chat")); await h.select();
  assert.deepEqual(h.messages.get("chat"), original);
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, "a0");
  assert.equal((await h.engine.loadStore("chat")).current, null);
  const failure = (await h.engine.status("chat", "owner")).setupProgress;
  assert.equal(failure.stage, "generating"); assert.equal(failure.status, "failed"); assert.match(failure.error, /Tracker generation failed \(transport\): PRIVATE_DIAGNOSTIC_WITH_SECRET/);
  h.setResponse(null); await h.engine.schedule("chat", {}, "owner");
  await h.open(); await h.events.get("MESSAGE_SENT")({ chatId: "chat" }, "owner");
  await h.engine.handleFrontend({ type: "story_set_widget_visibility", chatId: "chat", showStatusWidget: false }, "owner");
  assert.equal(h.requests.length, 1); assert.deepEqual((await h.engine.status("chat", "owner")).setupProgress, failure);
  await h.create();
  assert.deepEqual(h.messages.get("chat"), original);
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, null);
  assert.equal(h.requests.length, 2); assert.equal((await h.engine.status("chat", "owner")).setupProgress.status, "ready");
});

test("initial setup publishes real reading, generation, validation, repair and saving stages", async () => {
  const h = harness(); await h.open();
  h.setResponse(async () => {
    const progress = (await h.engine.status("chat", "owner")).setupProgress;
    assert.equal(progress.stage, h.requests.length === 1 ? "generating" : "repairing");
    assert.equal(progress.attempt, h.requests.length);
    return { content: h.requests.length === 1 ? "invalid" : JSON.stringify(modelOutput(undefined, { initialize: true })) };
  });
  await h.create();
  const progress = h.sent.map(entry => entry.payload.setupProgress).filter(Boolean);
  const stages = progress.map(entry => entry.stage).filter((stage, index, entries) => index === 0 || stage !== entries[index - 1]);
  assert.deepEqual(stages, ["reading", "generating", "validating", "repairing", "validating", "saving", "ready"]);
  assert.equal(new Set(progress.map(entry => entry.startedAt)).size, 1);
  const final = (await h.engine.status("chat", "owner")).setupProgress;
  assert.equal(final.status, "ready"); assert.equal(final.attempt, 2); assert.equal(final.elapsedMs, final.finishedAt - final.startedAt);
  assert.equal(h.requests.length, 2); assert.equal(h.messages.get("chat").length, 1);
});

test("a background reconciliation queued during Create cannot start a second failed setup attempt", async () => {
  const h = harness(); await h.open(); const set = h.api.storage.setJson; let queued;
  h.api.storage.setJson = async (path, value, options) => {
    await set(path, value, options);
    if (!queued && value.chatId === "chat" && value.initializationMode === "create" && !value.baseline && !value.setupProgress) {
      queued = h.engine.schedule("chat", {}, "owner");
    }
  };
  h.setResponse(async () => { throw new Error("Provider unavailable"); });
  await h.create(); await queued;
  assert.equal(h.requests.length, 1); assert.equal((await h.engine.loadStore("chat")).setupProgress.status, "failed");
});

test("source reading failures report the reading stage and wait for explicit retry", async () => {
  const h = harness(); await h.open(); const get = h.api.characters.get;
  const store = await h.engine.loadStore("chat"); store.sources = null; h.files.set(h.engine.pathFor("chat"), store);
  h.api.characters.get = async () => { throw new Error("Card source unavailable"); };
  await h.create();
  const failed = await h.engine.status("chat", "owner");
  assert.equal(failed.setupProgress.stage, "reading"); assert.equal(failed.setupProgress.error, "Card source unavailable");
  assert.equal(failed.canCreate, true);
  assert.equal(h.requests.length, 0);
  h.api.characters.get = get; await h.open(); assert.equal(h.requests.length, 0);
  await h.create(); assert.equal(h.requests.length, 1); assert.equal((await h.engine.loadStore("chat")).setupProgress.status, "ready");
});

test("saving failures retain the valid baseline and retry saving without generating profiles again", async () => {
  const h = harness(); await h.open(); const set = h.api.variables.chat.set; let fail = true;
  h.api.variables.chat.set = async (chatId, key, value) => {
    if (fail && key === CHAT_KEYS.state && value) { fail = false; throw new Error("Mirror write failed"); }
    return set(chatId, key, value);
  };
  await h.create(); const saved = await h.engine.loadStore("chat");
  assert.ok(saved.baseline); assert.equal(saved.setupProgress.status, "failed"); assert.equal(saved.setupProgress.stage, "saving");
  await h.open(); assert.equal(h.requests.length, 1); assert.equal((await h.engine.status("chat", "owner")).canCreate, true);
  await h.create(); const retried = await h.engine.loadStore("chat");
  assert.equal(h.requests.length, 1); assert.deepEqual(retried.baseline, saved.baseline); assert.equal(retried.setupProgress.status, "ready");
  assert.ok(h.variables.get(`chat:${CHAT_KEYS.state}`));
});

test("worker interruption and older setup failures remain inspectable until retry", async () => {
  for (const interrupted of [true, false]) {
    const h = harness(); await h.open(); const store = await h.engine.loadStore("chat");
    store.initializationMode = "create";
    store.lastError = interrupted ? "" : "Older setup validation failed";
    store.setupProgress = interrupted ? { stage: "generating", status: "running", startedAt: 1000, updatedAt: 2500, finishedAt: null, attempt: 1, error: "" } : null;
    h.files.set(h.engine.pathFor("chat"), store);
    const restarted = createStoryEngine(h.api);
    await restarted.handleFrontend({ type: "story_get_status", chatId: "chat" }, "owner");
    const failed = (await restarted.status("chat", "owner")).setupProgress;
    assert.equal(failed.status, "failed"); assert.equal(h.requests.length, 0);
    assert.equal(failed.interrupted, interrupted);
    if (interrupted) { assert.equal(failed.stage, "generating"); assert.equal(failed.elapsedMs, 1500); assert.match(failed.error, /interrupted/); }
    else { assert.equal(failed.startedAt, 0); assert.equal(failed.error, store.lastError); }
    await restarted.handleFrontend({ type: "story_create_setup", chatId: "chat", requestId: "retry" }, "owner");
    assert.equal(h.requests.length, 1); assert.equal((await restarted.loadStore("chat")).setupProgress.status, "ready");
  }
});

test("a failed native setup can be replaced by an import without another model request", async () => {
  const h = harness(); h.setResponse(async () => { throw new Error("Provider unavailable"); }); await h.select();
  const setup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: remapStateSources(fixtureState(), new Map(), "initial-setup") };
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", requestId: "import", fileText: JSON.stringify(setup) }, "owner");
  assert.equal(h.requests.length, 1); assert.equal(h.sent.at(-1).payload.ok, true);
  assert.equal((await h.engine.loadStore("chat")).setupProgress, null);
});

test("a committed profile retires setup controls even when later history tracking fails", async () => {
  const h = harness(); await h.open(); h.addTurn("Ada nods.");
  h.setResponse(async request => ({ content: request.messages[1].content.startsWith("INITIALIZE")
    ? JSON.stringify(modelOutput(undefined, { initialize: true })) : "invalid" }));
  await h.create(); const store = await h.engine.loadStore("chat");
  assert.ok(store.baseline); assert.ok(store.current); assert.ok(store.lastError);
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
  assert.equal(store.setupTargetMessageId, null);
});

test("deleting a legacy notice during tracking does not invalidate the story result", async () => {
  const h = harness(); await h.select(); addLegacyNotice(h, "generating"); h.addTurn("Coat removed.");
  h.setResponse(async () => {
    const notice = h.messages.get("chat").find(isInitializationNotice);
    h.messages.set("chat", h.messages.get("chat").filter(message => message.id !== notice.id));
    return { content: JSON.stringify(modelOutput()) };
  });
  await h.engine.schedule("chat", {}, "owner");
  const store = await h.engine.loadStore("chat");
  assert.equal(store.lastError, ""); assert.ok(store.checkpoints["a1::0"]); assert.equal(h.requests.length, 2);
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
});

test("legacy notices stay out of prompts when initialization failed or tracking is disabled", async () => {
  const h = harness(); await h.select();
  const notice = addLegacyNotice(h); await h.engine.schedule("chat", {}, "owner");
  const prompt = [{ role: "system", content: "Character voice" },
    { role: "assistant", content: "Older notice text", sourceMessageId: notice.id, __isChatHistory: true },
    { role: "user", content: "Continue" }];
  const active = await h.engine.intercept(prompt, { chatId: "chat", userId: "owner" });
  assert.equal(active.messages.length, 3); assert.equal(active.messages[0].content, "Character voice");
  assert.ok(!active.messages.some(message => message.sourceMessageId === notice.id));
  h.files.set("config.json", { enabled: false });
  assert.deepEqual(await h.engine.intercept(prompt, { chatId: "chat", userId: "owner" }), [prompt[0], prompt[2]]);
  const failed = harness(); failed.setResponse(async () => ({ content: "invalid" })); await failed.select();
  const failedNotice = addLegacyNotice(failed, "failed");
  const result = await failed.engine.intercept([{ role: "assistant", content: failedNotice.content, sourceMessageId: failedNotice.id }, prompt[2]], { chatId: "chat", userId: "owner" });
  assert.deepEqual(result, [prompt[2]]); assert.equal((await failed.engine.loadStore("chat")).current, null);
});

test("a restarted worker removes legacy ready/interrupted notices without changing saved state", async () => {
  const h = harness(); await h.select();
  const notice = addLegacyNotice(h); addLegacyNotice(h, "generating", "interrupted-notice");
  h.messages.get("chat").push({ id: "user-copy", role: "user", content: INITIALIZATION_NOTICE_TEXT.ready });
  const count = h.requests.length, before = await h.engine.loadStore("chat");
  const restarted = createStoryEngine(h.api);
  notice.content = "Storyteller v1.6.0 — edited administrative status"; notice.swipe_id = 2;
  await h.events.get("MESSAGE_EDITED")({ chatId: "chat", message: notice }, "owner");
  await restarted.schedule("chat", {}, "owner");
  // Some host events contain only the deleted ID, without notice metadata.
  await h.events.get("MESSAGE_DELETED")({ chatId: "chat", messageId: notice.id }, "owner");
  assert.equal(h.requests.length, count); assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
  assert.ok(h.messages.get("chat").some(message => message.id === "user-copy"));
  const after = await restarted.loadStore("chat");
  assert.equal(after.blocked, "");
  assert.deepEqual(after.current, before.current); assert.deepEqual(after.initialSetup, before.initialSetup);
  assert.deepEqual(after.checkpoints, before.checkpoints); assert.equal(after.revision, before.revision);
});

test("disabled tracking or missing permissions prevent setup extraction", async () => {
  for (const reason of ["disabled", "permissions"]) {
    const h = harness();
    if (reason === "disabled") h.files.set("config.json", { enabled: false }); else h.permissions.delete("generation");
    await h.select();
    const status = await h.engine.status("chat", "owner");
    assert.equal(status.code, reason); assert.equal(status.canCreate, false); assert.equal(status.canImport, false);
    assert.equal(h.requests.length, 0); assert.equal((await h.engine.loadStore("chat")).current, null);
  }
});

test("legacy removal failures retry without regenerating saved profiles", async () => {
  const retry = harness(); await retry.select(); addLegacyNotice(retry); const remove = retry.api.chat.deleteMessage;
  retry.api.chat.deleteMessage = async () => { throw new Error("Notice deletion unavailable"); };
  await retry.open(); const before = await retry.engine.loadStore("chat");
  assert.ok(before.current); assert.equal(retry.messages.get("chat").filter(isInitializationNotice).length, 1);
  retry.api.chat.deleteMessage = remove; await retry.engine.schedule("chat", {}, "owner");
  assert.equal(retry.messages.get("chat").filter(isInitializationNotice).length, 0); assert.equal(retry.requests.length, 1);
  assert.equal((await retry.engine.loadStore("chat")).revision, before.revision);
});

test("fresh chats wait for an explicit setup choice across events, prompt interception and restarts", async () => {
  const h = harness(); await h.open();
  let store = await h.engine.loadStore("chat"), status = await h.engine.status("chat", "owner");
  assert.equal(store.awaitingSetup, true); assert.equal(store.current, null); assert.equal(h.requests.length, 0);
  assert.equal(status.code, "setup"); assert.equal(status.canCreate, true); assert.equal(status.canImport, true);
  assert.equal(status.setupTargetMessageId, "a0");
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
  await h.events.get("MESSAGE_SENT")({ chatId: "chat" }, "owner");
  await h.open(); await h.engine.schedule("chat", { reprocess: true }, "owner");
  const prompt = [{ role: "assistant", content: CARD.first_mes, sourceMessageId: "a0" }, { role: "user", content: "Continue" }];
  assert.deepEqual(await h.engine.intercept(prompt, { chatId: "chat", userId: "owner" }), prompt);
  const restarted = createStoryEngine(h.api); await restarted.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 0); assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
  assert.equal((await restarted.status("chat", "owner")).setupTargetMessageId, "a0");
  await restarted.handleFrontend({ type: "story_create_setup", chatId: "chat", requestId: "choose" }, "owner");
  store = await restarted.loadStore("chat"); assert.ok(store.current); assert.equal(store.awaitingSetup, false); assert.equal(h.requests.length, 1);
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0); assert.equal(store.setupTargetMessageId, null);
  await restarted.handleFrontend({ type: "story_create_setup", chatId: "chat", requestId: "repeat" }, "owner");
  assert.equal(h.requests.length, 1);
});

test("pending legacy choice messages are removed and their controls move to the real opening", async () => {
  const h = harness(); await h.open(); addLegacyNotice(h, "choice");
  const restarted = createStoryEngine(h.api); await restarted.schedule("chat", {}, "owner");
  const status = await restarted.status("chat", "owner");
  assert.equal(status.awaitingSetup, true); assert.equal(status.setupTargetMessageId, "a0");
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.messages.get("chat").map(message => message.id), ["a0"]);
});

test("importing from the startup choice restores locally without an unused extraction call", async () => {
  const h = harness(); await h.open();
  const setup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: remapStateSources(fixtureState(), new Map(), "initial-setup") };
  setup.initialState.world.weather = "Clear skies";
  setup.initialState.world.date = setup.initialState.world.time = "Unknown";
  setup.initialState.characters[0].visible.dressAndLayers = "Unknown";
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: JSON.stringify(setup), requestId: "import" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 0);
  const store = await h.engine.loadStore("chat"), status = await h.engine.status("chat", "owner");
  assert.equal(store.current.world.weather, "Clear skies"); assert.equal(store.awaitingSetup, false);
  assert.equal(store.current.world.date, "Unknown"); assert.equal(store.current.world.time, "Unknown");
  assert.equal(store.current.characters[0].visible.dressAndLayers, "Unknown");
  assert.equal(status.canCreate, false); assert.equal(status.canBegin, true);
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
  const anchor = h.messages.get("chat").find(message => message.metadata?.story_continuity_setup);
  assert.ok(anchor); assert.ok(!h.noticeDeletes.some(message => message.id === anchor.id));
  await h.engine.handleFrontend({ type: "story_begin", chatId: "chat" }, "owner");
  assert.ok(h.messages.get("chat").some(message => message.id === "begin-response"));
  await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 0); assert.equal((await h.engine.status("chat", "owner")).canBegin, false);
});

test("invalid imports leave the startup choices usable without generating a profile", async () => {
  const h = harness(); await h.open();
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: "{}", requestId: "invalid" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, false); await h.open();
  const status = await h.engine.status("chat", "owner");
  assert.equal(status.canCreate, true); assert.equal(status.canImport, true); assert.equal(h.requests.length, 0);
  assert.equal(status.setupTargetMessageId, "a0");
});

test("user turns do not silently choose creation and import is limited to a fresh chat", async () => {
  const h = harness(); await h.open(); h.addTurn("Ada nods."); await h.engine.schedule("chat", {}, "owner");
  const status = await h.engine.status("chat", "owner");
  assert.equal(status.canCreate, true); assert.equal(status.canImport, false); assert.equal(h.requests.length, 0);
  await h.create(); assert.equal(h.requests.length, 2); assert.ok((await h.engine.loadStore("chat")).checkpoints["a1::0"]);
});

test("chats without an opening use drawer setup without creating a placeholder message", async () => {
  const h = harness(); await h.open();
  h.messages.set("chat", []);
  await h.open(); assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
  assert.equal((await h.engine.status("chat", "owner")).canCreate, true);
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, null);
  await h.create(); assert.ok((await h.engine.loadStore("chat")).current);
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
});

test("already initialized older saves resume without a new setup decision", async () => {
  const h = harness(); await h.select(); const calls = h.requests.length;
  const stored = h.files.get(h.engine.pathFor("chat"));
  for (const key of ["initializationMode", "awaitingSetup", "setupNoticeId", "setupNoticeShown"]) delete stored[key];
  await h.open();
  assert.equal((await h.engine.status("chat", "owner")).code, "active");
  assert.equal(h.requests.length, calls); assert.equal((await h.engine.loadStore("chat")).initializationMode, "create");
});
