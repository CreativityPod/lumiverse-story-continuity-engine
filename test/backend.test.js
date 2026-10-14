import assert from "node:assert/strict";
import test from "node:test";
import { createStoryEngine } from "../src/backend.js";
import { CHAT_KEYS, SETUP_FORMAT, IMPORT_LOADED_TEXT } from "../src/state.js";
import { remapStateSources, legacyTrackerState } from "../src/schemas.js";
import { CARD, SOURCES, fixtureState, modelOutput } from "./fixtures.js";

function harness() {
  const files = new Map(), variables = new Map(), events = new Map(), sent = [], requests = [];
  const messages = new Map([["chat", [{ id: "a0", role: "assistant", content: CARD.first_mes, swipe_id: 0 }]]]);
  const cards = new Map([["ada", structuredClone(CARD)]]), chats = new Map([["chat", { id: "chat", character_id: "ada", metadata: {} }]]);
  let response = null;
  const permissions = new Set(["generation", "interceptor", "chat_mutation", "characters", "chats", "ui_panels"]);
  const api = {
    permissions: { has: permission => permissions.has(permission), onChanged: () => {} },
    storage: { getJson: async (path, options) => structuredClone(files.get(path) ?? options?.fallback), setJson: async (path, value) => files.set(path, structuredClone(value)),
      list: async prefix => [...files.keys()].filter(path => path.startsWith(`${prefix}/`)).map(path => path.slice(prefix.length + 1)),
      read: async path => JSON.stringify(files.get(path)), delete: async path => files.delete(path) },
    variables: { chat: { set: async (id, key, value) => variables.set(`${id}:${key}`, value) } },
    chats: { get: async id => structuredClone(chats.get(id) ?? null) }, characters: { get: async id => structuredClone(cards.get(id) ?? null) },
    chat: { getMessages: async id => { if (!messages.has(id)) throw new Error("Chat not found"); return structuredClone(messages.get(id)); },
      appendMessage: async (id, message, options) => { const entry = { ...message, id: `appended-${messages.get(id).length}`, swipe_id: 0 }; messages.get(id).push(entry);
        if (options?.generate) messages.get(id).push({ id: "begin-response", role: "assistant", content: "Ada waits at the station." }); return { id: entry.id }; } },
    connections: { list: async () => [{ id: "default", provider: "openai", is_default: true }], get: async () => null },
    generate: { quiet: async input => { requests.push(input); if (response) return response(input); const state = modelOutput(undefined, { initialize: input.messages[1].content.startsWith("INITIALIZE") });
      if (input.messages[1].content.includes("Coat removed")) state.characters[0].visible.dressAndLayers = "White shirt; blue coat on bench";
      if (input.messages[1].content.includes("Door opened")) state.places[0].currentState = "Side door open";
      return { content: JSON.stringify(state) }; } },
    sendToFrontend: (payload, userId) => sent.push({ payload, userId }), registerInterceptor: handler => { api.interceptor = handler; },
    onFrontendMessage: handler => { api.frontend = handler; }, on: (name, handler) => events.set(name, handler), log: { info() {}, warn() {} },
  };
  const engine = createStoryEngine(api);
  const select = async (chatId = "chat") => engine.handleFrontend({ type: "story_get_status", chatId }, "owner");
  const addTurn = (text, id = "a1") => messages.get("chat").push({ id: `u-${id}`, role: "user", content: "Continue" }, { id, role: "assistant", content: text, swipe_id: 0 });
  return { api, engine, files, variables, messages, cards, chats, events, sent, requests, permissions, select, addTurn, setResponse: handler => { response = handler; } };
}

test("generic card initializes automatically, preserves original setup and rechecks without generation", async () => {
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
  const copied = h.messages.get("chat").slice(0, 3), map = Object.fromEntries(copied.map(message => [message.id, `fork-${message.id}`]));
  h.messages.set("fork", copied.map(message => ({ ...message, id: map[message.id] }))); h.chats.set("fork", { id: "fork", character_id: "ada" });
  const requests = h.requests.length;
  await h.events.get("CHAT_FORKED")({ sourceChatId: "chat", forkedChatId: "fork", forkedAtMessageId: "a1", messageIdMap: map }, "owner");
  assert.equal(h.requests.length, requests); const store = await h.engine.loadStore("fork");
  assert.equal(store.current.characters[0].sourceMessageId, "fork-a1"); assert.equal(store.current.places[0].currentState, "Side door locked"); assert.ok(!store.checkpoints["fork-a2::0"]);
});
test("portable import validates before writing and recovers from its metadata anchor", async () => {
  const h = harness(); await h.select();
  await h.engine.handleFrontend({ type: "story_import_setup", chatId: "chat", fileText: "{}", requestId: "bad" }, "owner"); assert.equal(h.messages.get("chat").length, 1); assert.equal(h.sent.at(-1).payload.ok, false);
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
