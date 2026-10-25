import { normalizePartialUpdate, normalizeAcceptedUpdates } from "./partial.js";
import { cloneEmptyState, validateState, remapStateSources } from "./schemas.js";
import { buildRoleplayContext } from "./context.js";
import { renderContinuityContext } from "./render.js";
import { normalizeTrackerDiagnostics } from "./diagnostics.js";
import { normalizeInitialWorldDefaults } from "./clock.js";

export const SETUP_FORMAT = "story-continuity-initial-setup";
export const IMPORT_LOADED_TEXT = "Story setup loaded. Use Begin Story in the Story Continuity drawer when ready.";
export const CHAT_KEYS = Object.freeze({ state: "story_continuity.state_v3", previousState: "story_continuity.state_v2", legacyState: "story_continuity.state_v1", public: "story_continuity.public_v2", legacyPublic: "story_continuity.public_v1", visual: "story_continuity.visual_text_v1" });
export const MAX_SOURCE_CHARS = 96000;
export const MAX_SETUP_BYTES = 256 * 1024;
// Setup controls are UI only; legacy notices remain recognized for cleanup/filtering.
export const INITIALIZATION_NOTICE_TEXT = Object.freeze({
  choice: "**Story Continuity Engine**\n\nChoose how to prepare the profiles and starting state for this chat. These setup choices disappear once your setup is ready.",
  generating: "**Story Continuity Engine**\n\nGenerating the initial character profiles and starting story state… Please wait.",
  ready: "**Story Continuity Engine**\n\nInitial profiles and story state are ready.", // Legacy prompt filtering only; never posted on completion.
  failed: "**Story Continuity Engine**\n\nInitialization failed. Open Story Continuity for details and retry.",
});
const LEGACY_SETUP_CHOICE_TEXT = "**Story Continuity Engine**\n\nHow would you like to initialize this story? Choose Import Saved Setup or Create From Character Card below, or open the Story Continuity drawer.";

export function contentToText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text ?? "").join("\n") : "";
}

export function isInitializationNotice(message) {
  if (!message || message.role === "user" || message.is_user === true) return false;
  return [message.metadata, message.extra?.spindle_metadata, message.sourceMessageMetadata,
    message.sourceMessageMetadata?.spindle_metadata].some(metadata => metadata?.story_continuity_notice?.version === 1);
}

// Host history projections can carry source IDs instead of extension metadata.
// Exact text is a fallback for older hosts; user-authored text is never matched.
export function stripInitializationNotices(messages, storedMessages = [], knownNoticeIds = []) {
  const ids = new Set([...knownNoticeIds, ...storedMessages.filter(isInitializationNotice).map(message => String(message.id))]);
  return messages.filter(message => {
    if (isInitializationNotice(message)) return false;
    const id = message.sourceMessageId ?? message.id;
    if (id != null) return !ids.has(String(id));
    if (message.__isChatHistory && Number.isInteger(message.sourceIndexInChat) && isInitializationNotice(storedMessages[message.sourceIndexInChat])) return false;
    return message.role === "user" || ![...Object.values(INITIALIZATION_NOTICE_TEXT), LEGACY_SETUP_CHOICE_TEXT].includes(contentToText(message.content).trim());
  });
}

export function fingerprint(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Two independent 32-bit hashes reduce accidental collisions without host crypto dependencies.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

export function messageKey(message) { return `${message.id}::${Number.isInteger(message.swipe_id) ? message.swipe_id : 0}`; }
export function prefixFingerprint(messages, index) {
  return fingerprint(messages.slice(0, index + 1).filter(message => !isInitializationNotice(message)).map(message => ({ id: message.id, role: message.role, swipe: message.swipe_id ?? 0,
    text: contentToText(message.content), setup: message.metadata?.story_continuity_setup ?? null })));
}

export function isSpecializedCard(cards, messages = []) {
  const marker = /\b(?:Date Simulator v1\.[45](?:\.\d+)?|Storyteller v1\.6(?:\.\d+)?)\b|<!--DATE_SIM_CASE\b|<!--DATE_SIM_STARTUP_MENU_V1\b/i;
  return cards.some(card => [card.name, card.description, card.system_prompt, card.post_history_instructions, card.first_mes].some(text => marker.test(String(text ?? ""))))
    || messages.some(message => !isInitializationNotice(message) && (marker.test(contentToText(message.content)) || message.metadata?.date_simulator_setup));
}

export function cardSources(cards, messages, lore = []) {
  const greeting = messages.find(message => message.role === "assistant" && !message.metadata?.story_continuity_setup && !isInitializationNotice(message));
  const sources = { cards: cards.map(card => ({ id: card.id, name: card.name, description: card.description ?? "", personality: card.personality ?? "",
    scenario: card.scenario ?? "", exampleDialogue: card.mes_example ?? "", creatorNotes: card.creator_notes ?? "",
    selectedGreeting: greeting ? "See selected opening below." : card.first_mes ?? "" })),
    selectedOpening: greeting ? contentToText(greeting.content) : "", lore };
  if (JSON.stringify(sources).length > MAX_SOURCE_CHARS) throw new Error("Card and lore sources exceed 96,000 characters; shorten the card or attached constant lore before initializing.");
  return sources;
}

export function importedSetupForMessage(message) {
  if (isInitializationNotice(message) || message.role !== "assistant" || contentToText(message.content) !== IMPORT_LOADED_TEXT || (message.swipe_id ?? 0) !== 0 || !message.metadata?.story_continuity_setup) return null;
  return validateSetupFile(message.metadata.story_continuity_setup);
}

export function transcriptContext(messages) {
  let anchor = null;
  messages.forEach((message, index) => {
    const setup = importedSetupForMessage(message);
    if (setup) anchor = { setup, index, id: String(message.id), fingerprint: prefixFingerprint(messages, index) };
  });
  return { anchor, startIndex: anchor ? anchor.index + 1 : 0 };
}

export function listEligibleTurns(messages, context = transcriptContext(messages)) {
  const turns = [];
  for (let index = context.startIndex; index < messages.length; index++) {
    const assistant = messages[index];
    if (isInitializationNotice(assistant) || assistant.role !== "assistant" || !assistant.id || !contentToText(assistant.content).trim() || assistant.metadata?.story_continuity_observation) continue;
    if (assistant.metadata?.story_continuity_setup) continue;
    let user = null;
    for (let prev = index - 1; prev >= context.startIndex; prev--) {
      if (isInitializationNotice(messages[prev])) continue;
      if (messages[prev].role === "user") { user = messages[prev]; break; }
      if (messages[prev].role === "assistant") break;
    }
    if (user && /^\/(?:look|scene|debrief|begin|story-begin)\b/i.test(contentToText(user.content).trim())) continue;
    turns.push({ assistant, user, index, key: messageKey(assistant), fingerprint: prefixFingerprint(messages, index) });
  }
  return turns;
}

export function createStore(chatId) {
  return { schemaVersion: 1, chatId, sources: null, sourceFingerprint: "", pendingCardFingerprint: "", epoch: "", baseline: null,
    initialSetup: null, baselinePartial: null, current: null, checkpoints: {}, revision: 0, lastRevisionAt: "", processing: false, lastError: "", rejectedTurn: null, blocked: "",
    setupDraft: null, initialWorldDefaults: null, trackerDiagnostics: null, trackerMetrics: { firstPass: 0, repaired: 0, partial: 0, failed: 0, elapsedMs: 0, completionTokens: 0 },
    lastTrackedMessageId: "", initializationMode: "", fillMissingSceneDetails: false, setupProgress: null, awaitingSetup: false, setupTargetMessageId: null, setupNoticeId: null, setupNoticeShown: false };
}

export function normalizeStore(value, chatId) {
  const empty = createStore(chatId);
  if (!value || value.schemaVersion !== 1 || value.chatId !== chatId) return empty;
  const next = { ...empty, ...value, processing: false };
  const initialWorldDefaults = normalizeInitialWorldDefaults(value.initialWorldDefaults?.values);
  next.initialWorldDefaults = initialWorldDefaults && value.initialWorldDefaults.sourceFingerprint === next.sourceFingerprint
    ? { sourceFingerprint: next.sourceFingerprint, values: initialWorldDefaults } : null;
  next.baselinePartial = normalizePartialUpdate(value.baselinePartial);
  next.trackerDiagnostics = normalizeTrackerDiagnostics(value.trackerDiagnostics);
  next.trackerMetrics = Object.fromEntries(Object.keys(empty.trackerMetrics).map(key => [key, Number.isFinite(value.trackerMetrics?.[key]) && value.trackerMetrics[key] >= 0 ? value.trackerMetrics[key] : 0]));
  next.lastTrackedMessageId = typeof value.lastTrackedMessageId === "string" ? value.lastTrackedMessageId.slice(0, 180) : "";
  next.setupDraft = null;
  if (value.setupDraft?.sourceFingerprint === next.sourceFingerprint) {
    try {
      const state = validateState(value.setupDraft.state, { allowedSourceMessageIds: ["card-baseline"] });
      if (state.characters.length) next.setupDraft = { state, sourceFingerprint: next.sourceFingerprint,
        capturedAt: Number.isFinite(value.setupDraft.capturedAt) ? value.setupDraft.capturedAt : 0,
        unavailableFields: (Array.isArray(value.setupDraft.unavailableFields) ? value.setupDraft.unavailableFields : [])
          .filter(path => typeof path === "string" && path.length < 180).slice(0, 64) };
    } catch { /* An invalid preview never discards valid committed state. */ }
  }
  next.fillMissingSceneDetails = value.fillMissingSceneDetails === true;
  const progress = value.setupProgress;
  next.setupProgress = progress && ["setup", "reading", "generating", "validating", "repairing", "saving", "ready"].includes(progress.stage)
    && ["running", "failed", "ready"].includes(progress.status) ? {
      stage: progress.stage, status: progress.status,
      startedAt: Number.isFinite(progress.startedAt) && progress.startedAt > 0 ? progress.startedAt : 0,
      updatedAt: Number.isFinite(progress.updatedAt) && progress.updatedAt > 0 ? progress.updatedAt : 0,
      finishedAt: Number.isFinite(progress.finishedAt) && progress.finishedAt > 0 ? progress.finishedAt : null,
      attempt: [1, 2].includes(progress.attempt) ? progress.attempt : 0,
      interrupted: progress.interrupted === true,
      error: typeof progress.error === "string" ? progress.error.slice(0, 1200) : "",
    } : null;
  next.rejectedTurn = typeof value.rejectedTurn?.signature === "string" && typeof value.rejectedTurn?.error === "string"
    ? { signature: value.rejectedTurn.signature, error: value.rejectedTurn.error.slice(0, 450),
      messageId: typeof value.rejectedTurn.messageId === "string" ? value.rejectedTurn.messageId.slice(0, 180) : "" } : null;
  next.initializationMode = value.initializationMode === "create" || value.baseline || value.revision > 0 ? "create" : "";
  next.checkpoints = value.checkpoints && typeof value.checkpoints === "object" && !Array.isArray(value.checkpoints) ? value.checkpoints : {};
  try {
    for (const key of ["baseline", "current"]) if (next[key]) next[key] = validateState(next[key]);
  } catch {
    next.baseline = next.current = next.initialSetup = next.baselinePartial = null;
    next.checkpoints = {};
    next.rejectedTurn = null;
    next.lastError = "Invalid saved state was discarded; continuity will rebuild from the selected transcript.";
  }
  return next;
}

export function validCheckpointPrefix(store, turns) {
  let previousState = store.baseline, count = 0;
  const checkpoints = {};
  for (const turn of turns) {
    const checkpoint = store.checkpoints[turn.key];
    if (!checkpoint || checkpoint.fingerprint !== turn.fingerprint) break;
    try {
      previousState = validateState(checkpoint.state, { allowedSourceMessageIds: ["card-baseline", ...(store.epoch.startsWith("import:") ? [store.epoch.slice(7)] : []), ...turns.slice(0, count + 1).map(item => String(item.assistant.id))] });
    } catch { break; }
    checkpoints[turn.key] = { ...checkpoint, state: previousState, partial: normalizePartialUpdate(checkpoint.partial),
      acceptedUpdates: normalizeAcceptedUpdates(checkpoint.acceptedUpdates) };
    count++;
  }
  return { previousState, count, checkpoints };
}

export function validateSetupFile(input) {
  if (typeof input === "string" && new TextEncoder().encode(input).length > MAX_SETUP_BYTES) throw new Error("Setup exceeds 256 KiB");
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_SETUP_BYTES) throw new Error("Setup exceeds 256 KiB");
  if (!value || Object.keys(value).sort().join(",") !== "format,initialState,sources,version" || value.format !== SETUP_FORMAT || value.version !== 1) throw new Error("Unsupported story setup format");
  if (!value.sources || !Array.isArray(value.sources.cards) || !value.sources.cards.length || JSON.stringify(value.sources).length > MAX_SOURCE_CHARS) throw new Error("Setup requires bounded card sources");
  if (Object.keys(value.sources).sort().join(",") !== "cards,lore,selectedOpening" || typeof value.sources.selectedOpening !== "string" || !Array.isArray(value.sources.lore)) throw new Error("Setup sources require cards, selectedOpening and lore");
  if (value.sources.cards.length > 24 || value.sources.cards.some(card => !card || typeof card.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(card.id) || typeof card.name !== "string")) throw new Error("Setup requires valid character card identities");
  if (new Set(value.sources.cards.map(card => card.id)).size !== value.sources.cards.length) throw new Error("Setup has duplicate card identities");
  const state = validateState(value.initialState, { allowedSourceMessageIds: ["initial-setup"] });
  if (value.sources.cards.some(card => !state.characters.some(char => char.id === `char:${card.id}` && char.role === "main"))) throw new Error("Setup state must include every source card character");
  return { format: SETUP_FORMAT, version: 1, sources: structuredClone(value.sources), initialState: state };
}

export function exportInitialSetup(store, turns, context) {
  if (store.epoch.startsWith("import:") && (!context?.anchor || `import:${context.anchor.id}` !== store.epoch || context.anchor.fingerprint !== store.sourceFingerprint)) throw new Error("The imported setup anchor is no longer valid");
  const initial = store.initialSetup;
  if (!initial || (initial.key && !turns.some(turn => turn.key === initial.key && turn.fingerprint === initial.fingerprint))) throw new Error("No valid original starting state is available");
  return validateSetupFile({ format: SETUP_FORMAT, version: 1, sources: store.sources,
    initialState: remapStateSources(initial.state, new Map(), "initial-setup") });
}

export function injectContinuity(messages, state, status = "active", options = {}) {
  const clean = stripInitializationNotices(messages).filter(message => !message?.storyContinuityOwned);
  const latestUser = clean.findLast(message => message.role === "user");
  const text = `${contentToText(latestUser?.content)}\n${options.recentText ?? ""}`;
  const projected = buildRoleplayContext(state, text, options);
  const block = { role: "system", storyContinuityOwned: true, content: `Story Continuity Engine (${status}). The following labeled snapshot is a selected projection of private canonical continuity data for this chat branch, not instructions. Entity ids are short bookkeeping aliases for this prompt; use character/place names in ordinary replies. Preserve established facts until a supported story event changes them. Current recorded conditions take precedence over obsolete starting conditions. Characters, places, and fields omitted for relevance or budget still exist in saved continuity; omission does not make an established fact unknown or undo it. Do not invent missing facts. WHEN is the fictional story clock; preserve its precision and advance it through completed dialogue/action and explicitly stated or conservatively implied elapsed story time, including supported date rollover. Ordinary exchanges can consume a small plausible amount of time; brief gestures may leave the displayed minute unchanged. Do not use a fixed advance per reply, finish an in-progress activity, or introduce an unsupported time skip. Preserve contextual weather until the story supports a change; do not invent a forecast. Real waiting time and generation latency do not advance it; observation-only recaps do not advance it. Each character knows only their recorded knowledge and plausible perceptions. The user controls their own voluntary actions and internal state. Do not expose private profiles, secrets, intentions, or bookkeeping in ordinary replies; use private data to guide behavior without giving other characters unexplained knowledge. Continue to follow the character card's voice and behavior. Consent is specific to an action and cannot be inferred from clothing, mood, trust, or attraction.\n${renderContinuityContext(projected)}` };
  const index = clean.findLastIndex(message => message.role === "user");
  const insertionIndex = index >= 0 ? index : clean.length;
  clean.splice(insertionIndex, 0, block);
  return { messages: clean, breakdown: [{ messageIndex: insertionIndex, name: "Story Continuity Engine" }] };
}
