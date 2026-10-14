import assert from "node:assert/strict";
import test from "node:test";
import { cardSources, isSpecializedCard, prefixFingerprint, listEligibleTurns, transcriptContext, createStore, validCheckpointPrefix, injectContinuity, validateSetupFile, exportInitialSetup, IMPORT_LOADED_TEXT, SETUP_FORMAT, INITIALIZATION_NOTICE_TEXT, isInitializationNotice, stripInitializationNotices } from "../src/state.js";
import { remapStateSources } from "../src/schemas.js";
import { CARD, SOURCES, fixtureState } from "./fixtures.js";

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
test("edit, swipe and import metadata changes invalidate branch fingerprints", () => {
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
test("observation commands and imported confirmation do not advance tracker turns", () => {
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

test("initialization notices never become greetings, tracked turns, or fingerprinted story events", () => {
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
