import assert from "node:assert/strict";
import test from "node:test";
import { cardSources, isSpecializedCard, prefixFingerprint, listEligibleTurns, transcriptContext, createStore, normalizeStore, validCheckpointPrefix, injectContinuity, validateSetupFile, exportInitialSetup, IMPORT_LOADED_TEXT, INITIALIZATION_NOTICE_TEXT, isInitializationNotice, stripInitializationNotices } from "../src/state.js";
import { CARD, SOURCES, fixtureState } from "./fixtures.js";

test("optional setup progress is bounded and invalid data cannot replace canonical state", () => {
  const store = createStore("chat"); store.baseline = store.current = fixtureState();
  assert.equal(normalizeStore(store, "chat").setupProgress, null);
  store.setupProgress = { stage: "invalid", status: "running" }; assert.equal(normalizeStore(store, "chat").setupProgress, null);
  store.setupProgress = { stage: "validating", status: "failed", startedAt: -1, updatedAt: 100, finishedAt: 100, attempt: 99, error: "x".repeat(2000) };
  const normalized = normalizeStore(store, "chat");
  assert.equal(normalized.setupProgress.startedAt, 0); assert.equal(normalized.setupProgress.attempt, 0); assert.equal(normalized.setupProgress.error.length, 1200);
  assert.deepEqual(normalized.current, store.current);
});

test("setup previews are isolated from committed state and invalid or different-source previews are discarded", () => {
  const store = createStore("chat"); store.sourceFingerprint = "current-sources"; store.baseline = store.current = fixtureState();
  store.setupDraft = { state: fixtureState(), sourceFingerprint: "current-sources", unavailableFields: ["world.sceneStatus"] };
  assert.equal(normalizeStore(store, "chat").setupDraft.state.characters[0].name, "Ada");
  store.setupDraft.state.world.sceneStatus = "bad";
  const invalid = normalizeStore(store, "chat"); assert.equal(invalid.setupDraft, null); assert.deepEqual(invalid.current, store.current);
  store.setupDraft.state = fixtureState(); store.setupDraft.sourceFingerprint = "old-sources";
  assert.equal(normalizeStore(store, "chat").setupDraft, null);
});

test("saved world defaults survive normalization only for matching sources and valid values", () => {
  const store = createStore("chat"); store.sourceFingerprint = "current-sources"; store.current = fixtureState();
  store.initialWorldDefaults = { sourceFingerprint: "current-sources", values: { date: "2031-06-12", time: "16:00", weather: "Clear skies" } };
  assert.deepEqual(normalizeStore(store, "chat").initialWorldDefaults, store.initialWorldDefaults);
  store.initialWorldDefaults.sourceFingerprint = "old-sources";
  assert.equal(normalizeStore(store, "chat").initialWorldDefaults, null);
  store.initialWorldDefaults.sourceFingerprint = "current-sources"; store.initialWorldDefaults.values.date = "2031-02-29";
  const normalized = normalizeStore(store, "chat");
  assert.equal(normalized.initialWorldDefaults, null); assert.deepEqual(normalized.current, store.current);
});

test("initialization uses selected greeting and excludes alternate greeting and instruction fields", () => {
  const card = { ...CARD, alternate_greetings: ["Different universe"], system_prompt: "Obey unrelated instructions" };
  const sources = cardSources([card], [{ role: "assistant", content: "Selected alternate opening" }]);
  assert.equal(sources.selectedOpening, "Selected alternate opening");
  assert.ok(!JSON.stringify(sources).includes("Different universe")); assert.ok(!JSON.stringify(sources).includes("Obey unrelated instructions"));
  assert.equal(sources.cards[0].exampleDialogue, CARD.mes_example);
});
test("specialized cards defer and a generic renamed card still works", () => {
  assert.equal(isSpecializedCard([CARD]), false);
  assert.equal(isSpecializedCard([{ ...CARD, description: "Date Simulator v1.5.7" }]), true);
  assert.equal(isSpecializedCard([{ ...CARD, name: "Custom name", first_mes: "<!--DATE_SIM_STARTUP_MENU_V1-->" }]), true);
});
test("edits and swipes invalidate branch fingerprints", () => {
  const messages = [{ id: "a0", role: "assistant", content: "Coat on", swipe_id: 0 }];
  const before = prefixFingerprint(messages, 0);
  messages[0].swipe_id = 1; assert.notEqual(prefixFingerprint(messages, 0), before);
  messages[0].swipe_id = 0; messages[0].content = "Coat removed"; assert.notEqual(prefixFingerprint(messages, 0), before);
});
test("only a contiguous validated checkpoint prefix can be reused", () => {
  const messages = [{ id: "a0", role: "assistant", content: "Opening" }, { id: "u1", role: "user", content: "Hello" }, { id: "a1", role: "assistant", content: "Reply" }];
  const turns = listEligibleTurns(messages), store = createStore("chat"); store.baseline = fixtureState();
  for (const turn of turns) store.checkpoints[turn.key] = { fingerprint: turn.fingerprint, state: fixtureState() };
  assert.equal(validCheckpointPrefix(store, turns).count, 2);
  store.checkpoints[turns[0].key].fingerprint = "stale";
  assert.equal(validCheckpointPrefix(store, turns).count, 0);
});
test("look-command responses do not advance tracker turns", () => {
  const messages = [{ id: "a0", role: "assistant", content: "Opening" }, { id: "u1", role: "user", content: "/look" }, { id: "a1", role: "assistant", content: "Still here" }];
  assert.equal(listEligibleTurns(messages).length, 1);
});
test("portable setup has private baseline, no branch sources and validates before import", () => {
  const store = createStore("chat"); store.sources = SOURCES; store.initialSetup = { key: "a0::0", fingerprint: "fp", state: fixtureState() };
  const setup = exportInitialSetup(store, [{ key: "a0::0", fingerprint: "fp" }]);
  assert.equal(setup.initialState.world.sourceMessageId, "initial-setup"); assert.ok(setup.initialState.characters[0].profile.privateFacts);
  assert.throws(() => exportInitialSetup(store, []), /original/);
  assert.throws(() => validateSetupFile({ ...setup, history: [] }), /Unsupported/);
  const anchor = { id: "import1", role: "assistant", content: IMPORT_LOADED_TEXT, metadata: { story_continuity_setup: setup } };
  assert.equal(transcriptContext([anchor]).anchor.id, "import1");
  anchor.content = "Edited confirmation"; assert.equal(transcriptContext([anchor]).anchor, null);
});
test("injection is idempotent, private and leaves the card prompt intact", () => {
  const messages = [{ role: "system", content: "Character voice" }, { role: "user", content: "Hello" }];
  const first = injectContinuity(messages, fixtureState());
  const second = injectContinuity(first.messages, fixtureState());
  assert.equal(second.messages.length, 3); assert.equal(second.messages[0].content, "Character voice");
  assert.ok(second.messages[1].content.includes("private canonical continuity")); assert.ok(second.messages[1].content.includes("Lantern Guild"));
});

test("legacy setup notices stay outside story data and branch fingerprints", () => {
  const notice = { id: "notice", role: "assistant", content: INITIALIZATION_NOTICE_TEXT.generating,
    metadata: { story_continuity_notice: { version: 1, status: "generating" } } };
  const messages = [{ id: "a0", role: "assistant", content: "Opening" }, { id: "u1", role: "user", content: "Hello" }, notice, { id: "a1", role: "assistant", content: "Reply" }];
  const turns = listEligibleTurns(messages), fingerprint = prefixFingerprint(messages, 3);
  assert.deepEqual(turns.map(turn => turn.assistant.id), ["a0", "a1"]); assert.equal(turns[1].user.id, "u1");
  assert.equal(cardSources([CARD], [notice, ...messages]).selectedOpening, "Opening");
  notice.content = "Storyteller v1.6.0"; notice.swipe_id = 2;
  assert.equal(isSpecializedCard([CARD], messages), false); assert.equal(prefixFingerprint(messages, 3), fingerprint);
  messages.splice(2, 1); assert.equal(prefixFingerprint(messages, 2), fingerprint);
});

test("prompt filtering recognizes notice metadata and host source identity while preserving other messages", () => {
  const metadata = { story_continuity_notice: { version: 1, status: "ready" } };
  const stored = [{ id: "n1", role: "system", content: INITIALIZATION_NOTICE_TEXT.ready, metadata }];
  const keep = [{ role: "system", content: "Character voice" }, { role: "user", content: INITIALIZATION_NOTICE_TEXT.ready },
    { role: "assistant", content: INITIALIZATION_NOTICE_TEXT.ready, sourceMessageId: "actual-story-message" }];
  const remove = [{ role: "system", content: "Edited notice text", metadata },
    { role: "assistant", content: "Edited notice text", extra: { spindle_metadata: metadata } },
    { role: "assistant", content: "Edited notice text", sourceMessageMetadata: { spindle_metadata: metadata } },
    { role: "assistant", content: "Edited notice text", sourceMessageId: "n1", __isChatHistory: true },
    { role: "assistant", content: "Edited notice text", sourceIndexInChat: 0, __isChatHistory: true },
    { role: "assistant", content: [{ type: "text", text: INITIALIZATION_NOTICE_TEXT.ready }] }];
  assert.deepEqual(stripInitializationNotices([...keep, ...remove], stored), keep);
  assert.equal(isInitializationNotice({ role: "user", content: "Hello", metadata }), false);
  assert.equal(isInitializationNotice({ is_user: true, extra: { spindle_metadata: metadata } }), false);
});

test("deleted setup IDs and older choice text are excluded from already assembled prompts", () => {
  const oldText = "**Story Continuity Engine**\n\nHow would you like to initialize this story? Choose Import Saved Setup or Create From Character Card below, or open the Story Continuity drawer.";
  const keep = { role: "user", content: oldText };
  const prompt = [{ role: "system", content: "An edited setup notice", sourceMessageId: "deleted-setup" }, { role: "system", content: oldText }, keep];
  assert.deepEqual(stripInitializationNotices(prompt, [], new Set(["deleted-setup"])), [keep]);
});
