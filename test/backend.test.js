import assert from "node:assert/strict";
import test from "node:test";
import { createStoryEngine } from "../src/backend.js";
import { CHAT_KEYS, SETUP_FORMAT, IMPORT_LOADED_TEXT, INITIALIZATION_NOTICE_TEXT, isInitializationNotice, listEligibleTurns } from "../src/state.js";
import { remapStateSources, legacyTrackerState } from "../src/schemas.js";
import { CARD, SOURCES, fixtureState, modelOutput } from "./fixtures.js";

function harness() {
  const files = new Map(), variables = new Map(), events = new Map(), sent = [], requests = [], noticeWrites = [], noticeDeletes = [];
  const messages = new Map([["chat", [{ id: "a0", role: "assistant", content: CARD.first_mes, swipe_id: 0 }]]]);
  const cards = new Map([["ada", structuredClone(CARD)]]), chats = new Map([["chat", { id: "chat", character_id: "ada", metadata: {} }]]);
  let response = null, messageSequence = 0;
  const emitNoticeEvent = async (name, chatId, message) => {
    if (isInitializationNotice(message)) await events.get(name)?.({ chatId, message: { id: message.id, is_user: false, content: message.content, extra: { spindle_metadata: message.metadata } } }, "owner");
  };
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
        if (isInitializationNotice(entry)) noticeWrites.push(structuredClone(entry));
        await emitNoticeEvent("MESSAGE_SENT", id, entry);
        if (options?.triggerGeneration) messages.get(id).push({ id: "begin-response", role: "assistant", content: "Ada waits at the station." }); return { id: entry.id }; },
      updateMessage: async (chatId, messageId, patch) => {
        const entry = messages.get(chatId)?.find(message => message.id === messageId); if (!entry) throw new Error("Message not found");
        if (patch.content !== undefined) entry.content = patch.content;
        if (patch.metadata !== undefined) entry.metadata = structuredClone(patch.metadata);
        if (isInitializationNotice(entry)) noticeWrites.push(structuredClone(entry));
        await emitNoticeEvent("MESSAGE_EDITED", chatId, entry);
      },
      deleteMessage: async (chatId, messageId) => {
        const entry = messages.get(chatId)?.find(message => message.id === messageId); if (!entry) throw new Error("Message not found");
        messages.set(chatId, messages.get(chatId).filter(message => message.id !== messageId));
        if (isInitializationNotice(entry)) noticeDeletes.push(structuredClone(entry));
        await emitNoticeEvent("MESSAGE_DELETED", chatId, entry);
      },
      setMessageHidden: async (chatId, messageId, hidden) => {
        const entry = messages.get(chatId)?.find(message => message.id === messageId); if (!entry) throw new Error("Message not found");
        entry.extra = { ...entry.extra, hidden }; await emitNoticeEvent("MESSAGE_EDITED", chatId, entry);
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
  return { api, engine, files, variables, messages, cards, chats, events, sent, requests, noticeWrites, noticeDeletes, permissions, select, open, create, addTurn, setResponse: handler => { response = handler; } };
}

function addLegacyNotice(h, phase = "ready", id = "legacy-notice") {
  const notice = { id, role: "system", content: INITIALIZATION_NOTICE_TEXT[phase], metadata: { story_continuity_notice: { version: 1, status: phase } } };
  h.messages.get("chat").push(notice); return notice;
}

test("chosen card setup initializes, preserves original setup and rechecks without generation", async () => {
  const h = harness(); await h.select();
  const store = await h.engine.loadStore("chat"); assert.equal(h.requests.length, 1); assert.ok(store.initialSetup);
  assert.equal(store.current.characters[0].visible.dressAndLayers, "Blue coat");
  const revision = store.revision, timestamp = store.lastRevisionAt;
  await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, 1); assert.equal((await h.engine.loadStore("chat")).revision, revision); assert.equal((await h.engine.loadStore("chat")).lastRevisionAt, timestamp);
  assert.ok(h.variables.get(`chat:${CHAT_KEYS.state}`).includes("Lantern Guild"));
  assert.ok(!h.variables.get(`chat:${CHAT_KEYS.public}`).includes("Lantern Guild"));
  assert.equal((await h.engine.status("chat", "owner")).canImport, true);
});
test("new turns update clothing and place state while export remains the original opening", async () => {
  const h = harness(); await h.select(); h.addTurn("Coat removed. Door opened."); await h.engine.schedule("chat", {}, "owner");
  const store = await h.engine.loadStore("chat"); assert.equal(store.current.characters[0].visible.dressAndLayers, "White shirt; blue coat on bench"); assert.equal(store.current.places[0].currentState, "Side door open");
  await h.engine.handleFrontend({ type: "story_export_setup", chatId: "chat", requestId: "export" }, "owner");
  const result = h.sent.at(-1).payload; assert.equal(result.ok, true);
  const portable = JSON.parse(result.fileText); assert.equal(portable.initialState.characters[0].visible.dressAndLayers, "Blue coat"); assert.ok(!result.fileText.includes('"a1"'));
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
  await h.engine.handleFrontend({ type: "story_begin", chatId: "chat" }, "owner"); await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, count); assert.equal((await h.engine.status("chat", "owner")).canBegin, false);
});
test("chat deletion waits for pending work and cleanup requires confirmation with a fresh scan", async () => {
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
  await h.engine.schedule("chat", {}, "owner"); assert.equal(h.requests.length, 2); assert.equal((await h.engine.loadStore("chat")).current.world.time, "Midnight");
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
  assert.equal(JSON.parse(h.variables.get(`chat:${CHAT_KEYS.state}`)).schemaVersion, 2);
  assert.equal(JSON.parse(h.variables.get(`chat:${CHAT_KEYS.legacyState}`)).schemaVersion, 1);
  const legacySetup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: remapStateSources(legacyTrackerState(fixtureState()), new Map(), "initial-setup") };
  legacySetup.initialState = legacyTrackerState(legacySetup.initialState);
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: JSON.stringify(legacySetup), requestId: "legacy-import" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, count); assert.equal((await h.engine.loadStore("chat")).current.schemaVersion, 2);
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
  assert.ok(injection.messages[0].content.includes('"id":"c1"')); assert.ok(!injection.messages[0].content.includes(guid));
  assert.ok(!h.requests[0].messages.map(message => message.content).join("\n").includes(guid));
  h.addTurn("Ada removes the coat.");
  h.setResponse(async () => {
    const invalid = modelOutput(proposed, { sources }); invalid.characters[0].id = "c99"; invalid.characters[0].visible.dressAndLayers = "Coat removed";
    return { content: JSON.stringify(invalid) };
  });
  await h.engine.schedule("chat", {}, "owner");
  const failed = await h.engine.loadStore("chat");
  assert.equal(h.requests.length, 3); assert.match(failed.lastError, /unknown/); assert.ok(!failed.checkpoints["a1::0"]);
  assert.deepEqual(failed.current, initial.current); assert.equal(failed.current.characters.length, 1);
  assert.equal(failed.revision, initial.revision);
  assert.ok(h.variables.get(`chat:${CHAT_KEYS.state}`).includes(guid));
});

test("setup targets the opening and initialization writes no setup or completion messages", async () => {
  const h = harness(); let release, started;
  const original = structuredClone(h.messages.get("chat")); await h.open();
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, "a0");
  const gate = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { started = resolve; });
  h.setResponse(async () => { started(); await gate; return { content: JSON.stringify(modelOutput(undefined, { initialize: true })) }; });
  const pending = h.select(); await observed;
  assert.deepEqual(h.messages.get("chat"), original);
  assert.equal((await h.engine.loadStore("chat")).current, null);
  release(); await pending;
  assert.deepEqual(h.noticeWrites, []); assert.deepEqual(h.noticeDeletes, []); assert.deepEqual(h.messages.get("chat"), original);
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, null); assert.equal(h.requests.length, 1);
  assert.deepEqual(Object.keys((await h.engine.loadStore("chat")).checkpoints), ["a0::0"]);
  assert.ok(!JSON.stringify(h.requests[0].messages).includes("Generating the initial character profiles"));
  const count = h.noticeWrites.length;
  h.setResponse(null); h.addTurn("Ada nods."); await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.noticeWrites.length, count); assert.equal(h.requests.length, 2);
  assert.equal(listEligibleTurns(h.messages.get("chat")).length, 2);
});

test("failed initialization keeps the opening target available for retry without posting diagnostics", async () => {
  const h = harness(); h.setResponse(async () => { throw new Error("PRIVATE_DIAGNOSTIC_WITH_SECRET"); });
  const original = structuredClone(h.messages.get("chat")); await h.select();
  assert.deepEqual(h.messages.get("chat"), original);
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, "a0");
  assert.equal((await h.engine.loadStore("chat")).current, null);
  h.setResponse(null); await h.engine.schedule("chat", {}, "owner");
  assert.deepEqual(h.messages.get("chat"), original); assert.deepEqual(h.noticeWrites, []);
  assert.equal((await h.engine.status("chat", "owner")).setupTargetMessageId, null);
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

test("notice edits and deletion do not invalidate checkpoints or reset the opening", async () => {
  const h = harness(); await h.select(); h.addTurn("Ada nods."); await h.engine.schedule("chat", {}, "owner");
  const notice = addLegacyNotice(h), before = await h.engine.loadStore("chat"), calls = h.requests.length;
  notice.content = "Storyteller v1.6.0 — edited administrative status"; notice.swipe_id = 2;
  await h.events.get("MESSAGE_EDITED")({ chatId: "chat", message: notice }, "owner");
  await h.engine.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, calls); assert.equal((await h.engine.loadStore("chat")).blocked, "");
  h.messages.set("chat", h.messages.get("chat").filter(message => message.id !== notice.id));
  await h.events.get("MESSAGE_DELETED")({ chatId: "chat", messageId: notice.id }, "owner");
  await h.engine.schedule("chat", {}, "owner");
  const after = await h.engine.loadStore("chat");
  assert.equal(h.requests.length, calls); assert.equal(after.revision, before.revision); assert.deepEqual(after.checkpoints, before.checkpoints);
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
});

test("deleting the notice during a tracker call keeps valid story output and does not recreate it", async () => {
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

test("notice history is stripped from prompts even when initialization failed or tracking is disabled", async () => {
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
  addLegacyNotice(h); addLegacyNotice(h, "generating", "interrupted-notice");
  h.messages.get("chat").push({ id: "user-copy", role: "user", content: INITIALIZATION_NOTICE_TEXT.ready });
  const count = h.requests.length, before = await h.engine.loadStore("chat");
  const restarted = createStoryEngine(h.api); await restarted.schedule("chat", {}, "owner");
  assert.equal(h.requests.length, count); assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
  assert.ok(h.messages.get("chat").some(message => message.id === "user-copy"));
  const after = await restarted.loadStore("chat");
  assert.deepEqual(after.current, before.current); assert.deepEqual(after.initialSetup, before.initialSetup);
  assert.deepEqual(after.checkpoints, before.checkpoints); assert.equal(after.revision, before.revision);
});

test("specialized, disabled and imported chats do not post generation notices", async () => {
  const specialized = harness(); specialized.cards.get("ada").description = "Date Simulator v1.5.7"; await specialized.select();
  assert.equal(specialized.messages.get("chat").filter(isInitializationNotice).length, 0);
  const disabled = harness(); disabled.files.set("config.json", { enabled: false }); await disabled.select();
  assert.equal(disabled.messages.get("chat").filter(isInitializationNotice).length, 0);
  const denied = harness(); denied.permissions.delete("generation"); await denied.select();
  assert.equal(denied.messages.get("chat").filter(isInitializationNotice).length, 0);
  const imported = harness(), setup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: remapStateSources(fixtureState(), new Map(), "initial-setup") };
  await imported.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: JSON.stringify(setup) }, "owner");
  assert.equal(imported.sent.at(-1).payload.ok, true); assert.equal(imported.requests.length, 0);
  assert.equal(imported.messages.get("chat").filter(isInitializationNotice).length, 0);
});

test("setup needs no chat writes and legacy removal failures retry without generation", async () => {
  const absent = harness(); absent.api.chat.appendMessage = async () => { throw new Error("Notice service unavailable"); };
  await absent.select(); assert.ok((await absent.engine.loadStore("chat")).current); assert.equal(absent.requests.length, 1);
  const h = harness();
  h.api.chat.updateMessage = async () => { throw new Error("Notice edit unavailable"); };
  await h.select(); assert.ok((await h.engine.loadStore("chat")).current);
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
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
  assert.equal(h.requests.length, 0); assert.deepEqual(h.noticeWrites, []);
  assert.deepEqual(h.messages.get("chat").map(message => message.id), ["a0"]);
});

test("importing from the startup choice restores locally without an unused extraction call", async () => {
  const h = harness(); await h.open();
  const setup = { format: SETUP_FORMAT, version: 1, sources: SOURCES, initialState: remapStateSources(fixtureState(), new Map(), "initial-setup") };
  setup.initialState.world.weather = "Clear skies";
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: JSON.stringify(setup), requestId: "import" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, true); assert.equal(h.requests.length, 0);
  const store = await h.engine.loadStore("chat"), status = await h.engine.status("chat", "owner");
  assert.equal(store.current.world.weather, "Clear skies"); assert.equal(store.awaitingSetup, false);
  assert.equal(status.canCreate, false); assert.equal(status.canBegin, true);
  assert.deepEqual(h.noticeWrites, []);
  assert.equal(h.messages.get("chat").filter(isInitializationNotice).length, 0);
  const anchor = h.messages.get("chat").find(message => message.metadata?.story_continuity_setup);
  assert.ok(anchor); assert.ok(!h.noticeDeletes.some(message => message.id === anchor.id));
  await h.engine.handleFrontend({ type: "story_begin", chatId: "chat" }, "owner");
  assert.ok(h.messages.get("chat").some(message => message.id === "begin-response"));
  assert.equal(h.requests.length, 0);
});

test("invalid imports leave the startup choices usable without generating a profile", async () => {
  const h = harness(); await h.open();
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: "{}", requestId: "invalid" }, "owner");
  assert.equal(h.sent.at(-1).payload.ok, false); await h.open();
  const status = await h.engine.status("chat", "owner");
  assert.equal(status.canCreate, true); assert.equal(status.canImport, true); assert.equal(h.requests.length, 0);
  assert.equal(status.setupTargetMessageId, "a0"); assert.deepEqual(h.noticeWrites, []);
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
