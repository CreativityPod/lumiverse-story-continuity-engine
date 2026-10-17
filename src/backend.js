import { validateState, publicTrackerSnapshot, remapStateSources, legacyTrackerState } from "./schemas.js";
import { CHAT_KEYS, IMPORT_LOADED_TEXT, isInitializationNotice, stripInitializationNotices, cardSources, fingerprint, isSpecializedCard, contentToText,
  transcriptContext, listEligibleTurns, prefixFingerprint, createStore, normalizeStore, validCheckpointPrefix,
  validateSetupFile, importedSetupForMessage, exportInitialSetup, injectContinuity } from "./state.js";
import { DEFAULT_CONFIG, normalizeConfig, runTracker } from "./tracker.js";

export function createStoryEngine(api) {
  const queues = new Map(), selected = new Map(), users = new Map(), processing = new Set(), deleted = new Set(), generating = new Set(), beginning = new Set(), cleanupTokens = new Map(), noticeIds = new Map();
  let registered = false;
  const userKey = userId => userId || "default";
  const safeToken = chatId => `${String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 150)}-${fingerprint(String(chatId))}`;
  const pathFor = chatId => `chats/${safeToken(chatId)}.json`;
  const has = permission => api.permissions.has(permission);
  const loadConfig = async () => normalizeConfig(await api.storage.getJson("config.json", { fallback: DEFAULT_CONFIG }));
  const loadStore = async chatId => normalizeStore(await api.storage.getJson(pathFor(chatId), { fallback: createStore(chatId) }), chatId);
  const saveStore = async store => { if (!deleted.has(store.chatId)) await api.storage.setJson(pathFor(store.chatId), store, { indent: 2 }); };
  const send = (payload, userId) => api.sendToFrontend(payload, userId);
  const required = ["generation", "interceptor", "chat_mutation", "characters", "chats"];
  const rejectionRetryHint = " Automatic retries are paused for this turn. Use Reprocess Latest Turn to retry.";
  const interruptedSetupError = "Initial setup was interrupted. Inspect the last stage, then select Retry Setup to start again.";
  const selection = userId => selected.get(userKey(userId));
  function adopt(chatId, userId) { const id = typeof chatId === "string" && chatId ? chatId : null; selected.set(userKey(userId), id); if (id) users.set(id, userId); return id; }
  function requestChat(payload, userId) {
    if (payload.chatId === null) { adopt(null, userId); return null; }
    const current = selection(userId);
    if (current === undefined && typeof payload.chatId === "string") return adopt(payload.chatId, userId);
    return current && (!Object.hasOwn(payload, "chatId") || current === payload.chatId) ? current : null;
  }
  async function getSources(chatId, messages, userId) {
    const chat = await api.chats.get(chatId, userId);
    if (!chat) throw new Error("Chat not found");
    const ids = [...new Set([chat.character_id, ...(Array.isArray(chat.metadata?.character_ids) ? chat.metadata.character_ids : [])].filter(id => typeof id === "string" && id))];
    if (!ids.length) throw new Error("This chat has no character card");
    if (ids.length > 24) throw new Error("At most 24 card characters can be initialized");
    const cards = [];
    for (const id of ids) { const card = await api.characters.get(id, userId); if (!card) throw new Error("A chat character card is unavailable"); cards.push(card); }
    const lore = [];
    // Only always-active, enabled attached lore is read at initialization. Conditional
    // entries remain under the host's activation rules and are learned from narrative.
    if (has("world_books") && api.world_books?.entries?.list) {
      const books = [...new Set(cards.flatMap(card => card.world_book_ids ?? []))];
      for (const book of books) {
        let offset = 0;
        do {
          const page = await api.world_books.entries.list(book, { limit: 100, offset, userId });
          const entries = page?.data ?? [];
          for (const entry of entries) if (entry.constant === true && entry.disabled !== true) lore.push({ id: entry.id, content: entry.content });
          offset += entries.length;
          if (!entries.length || offset >= (page.total ?? offset)) break;
          if (offset > 5000) throw new Error("Attached lore is too large to initialize safely");
        } while (true);
      }
    }
    return { chat, cards, sources: cardSources(cards, messages, lore) };
  }
  async function mirror(store) {
    if (!has("chat_mutation") || deleted.has(store.chatId)) return;
    for (const [key, value] of [[CHAT_KEYS.state, store.current && !store.blocked ? JSON.stringify(store.current) : ""],
      [CHAT_KEYS.legacyState, store.current && !store.blocked ? JSON.stringify(legacyTrackerState(store.current)) : ""],
      [CHAT_KEYS.public, store.current && !store.blocked ? JSON.stringify(publicTrackerSnapshot(store.current)) : ""]]) {
      if (!api.variables.chat.get || await api.variables.chat.get(store.chatId, key) !== value) await api.variables.chat.set(store.chatId, key, value);
    }
  }
  async function status(chatId, userId, includePrivate = false) {
    const config = await loadConfig();
    const store = chatId ? await loadStore(chatId) : null;
    const missing = required.filter(permission => !has(permission));
    const busy = chatId && processing.has(chatId);
    let setupProgress = store?.setupProgress && { ...store.setupProgress };
    if (setupProgress?.status === "running" && !busy) setupProgress = { ...setupProgress, status: "failed", error: interruptedSetupError, finishedAt: setupProgress.updatedAt, interrupted: true };
    if (setupProgress) setupProgress.elapsedMs = setupProgress.startedAt ? Math.max(0, (setupProgress.finishedAt ?? Date.now()) - setupProgress.startedAt) : 0;
    const code = !chatId ? "idle" : missing.length ? "permissions" : !config.enabled ? "disabled" : store.blocked ? "specialized" : busy ? "processing" : store.lastError || setupProgress?.status === "failed" ? "degraded" : store.awaitingSetup ? "setup" : store.current ? "active" : "ready";
    const text = { idle: "Open a character chat to begin.", permissions: `Grant required permissions: ${missing.join(", ")}.`, disabled: "Story continuity tracking is disabled.",
      specialized: store?.blocked, processing: "Updating character and world continuity…", degraded: setupProgress?.status === "failed" ? "Initial setup stopped. Expand error details below." : store?.lastError,
      setup: "Choose Import Saved Setup or Create From Character Card.", active: "Story continuity is current.", ready: "Checking story setup…" }[code];
    const payload = { type: "story_status", chatId, config, code, text, processing: Boolean(busy), level: code === "active" ? "green" : "amber",
      revision: store?.revision ?? 0, lastRevisionAt: store?.lastRevisionAt ?? "", cardChanged: Boolean(store?.pendingCardFingerprint),
      snapshot: store && !store.blocked ? publicTrackerSnapshot(store.current) : null, canExport: Boolean(store?.initialSetup),
      canBegin: Boolean(store?.canBegin && !busy && !generating.has(chatId)),
      canImport: Boolean(chatId && config.enabled && !missing.length && !busy && !generating.has(chatId) && store?.importable && !store?.blocked),
      canCreate: Boolean(chatId && config.enabled && !missing.length && !busy && !generating.has(chatId) && (store?.sources || setupProgress?.status === "failed") && (!store.baseline || setupProgress?.status === "failed") && !store.blocked && !store.epoch.startsWith("import:")),
      awaitingSetup: Boolean(store?.awaitingSetup), setupTargetMessageId: store?.setupTargetMessageId ?? null,
      fillMissingSceneDetails: store?.fillMissingSceneDetails === true,
      setupProgress: setupProgress ?? null,
      privateStateIncluded: includePrivate };
    if (includePrivate && store && !store.blocked) payload.privateState = store.current;
    return payload;
  }
  async function publish(chatId, userId, includePrivate = false) {
    const payload = await status(chatId, userId, includePrivate);
    if ((selection(userId) ?? null) === chatId) send(payload, userId);
    return payload;
  }
  async function setupStage(store, stage, userId, { attempt = store.setupProgress?.attempt ?? 0, error = "", start = false, interrupted = false, unknownStart = false } = {}) {
    const now = Date.now(), previous = start ? null : store.setupProgress;
    const status = error ? "failed" : stage === "ready" ? "ready" : "running";
    store.setupProgress = { stage, status, startedAt: unknownStart ? 0 : previous?.startedAt ?? now, updatedAt: now,
      finishedAt: status === "running" ? null : interrupted ? previous?.updatedAt ?? now : now,
      attempt, interrupted, error: error.slice(0, 1200) };
    await saveStore(store); await publish(store.chatId, userId);
  }
  async function matches(chatId, messages, index) {
    if (deleted.has(chatId)) return false;
    const latest = await api.chat.getMessages(chatId);
    const currentIndex = latest.findIndex(message => message.id === messages[index]?.id);
    return currentIndex >= 0 && prefixFingerprint(latest, currentIndex) === prefixFingerprint(messages, index);
  }
  const commitRevision = store => { store.revision++; store.lastRevisionAt = new Date().toISOString(); };

  function rememberNotices(chatId, messages) {
    const ids = noticeIds.get(chatId) ?? new Set();
    for (const message of messages) if (isInitializationNotice(message)) ids.add(String(message.id));
    noticeIds.set(chatId, ids);
  }
  async function removeInitializationNotices(store) {
    if (deleted.has(store.chatId)) return;
    try {
      const messages = await api.chat.getMessages(store.chatId);
      const notices = messages.filter(message => isInitializationNotice(message) && !message.metadata?.story_continuity_setup);
      // Remember IDs before deleting: host delete events and an already assembled
      // prompt may still refer to these temporary setup rows.
      rememberNotices(store.chatId, notices);
      for (const notice of notices) {
        if (deleted.has(store.chatId)) return;
        await api.chat.deleteMessage(store.chatId, notice.id);
      }
      store.setupNoticeId = null;
      await saveStore(store);
    } catch {
      // Legacy notices have no setup authority; retry cleanup on a later check.
      api.log.warn("Story continuity setup panel could not be removed.");
    }
  }

  async function reconcile(chatId, options = {}, userId = users.get(chatId)) {
    if (!chatId || deleted.has(chatId)) return;
    const config = await loadConfig();
    if (!config.enabled || required.some(permission => !has(permission))) return publish(chatId, userId, options.includePrivate);
    let store = await loadStore(chatId);
    processing.add(chatId);
    const deadline = Date.now() + 240000;
    let initializationNotice = null, trackerAttempt = null, setupRun = false;
    try {
      const messages = await api.chat.getMessages(chatId);
      rememberNotices(chatId, messages);
      initializationNotice = messages.find(isInitializationNotice) ?? null;
      if (initializationNotice) { store.setupNoticeId = initializationNotice.id; store.setupNoticeShown = true; }
      else store.setupNoticeId = null;
      const context = transcriptContext(messages), turns = listEligibleTurns(messages, context);
      if (!context.anchor) {
        if (store.setupProgress?.status === "running") {
          store.lastError = interruptedSetupError;
          await setupStage(store, store.setupProgress.stage, userId, { error: store.lastError, interrupted: true });
        } else if (!store.baseline && store.initializationMode === "create" && store.lastError && !store.setupProgress
          && !store.lastError.startsWith("Invalid saved state was discarded")) {
          await setupStage(store, "setup", userId, { error: store.lastError, unknownStart: true });
        }
        if (store.setupProgress?.status === "failed" && !options.retrySetup) {
          const narrative = messages.filter(message => ["assistant", "user"].includes(message.role) && !isInitializationNotice(message)
            && !message.metadata?.story_continuity_setup && contentToText(message.content).trim());
          store.setupTargetMessageId = store.baseline ? null : (narrative.find(message => message.role === "assistant") ?? narrative[0])?.id ?? null;
          store.importable = !messages.some(message => message.role === "user");
          await saveStore(store); return;
        }
        if (options.retrySetup || !store.baseline && store.initializationMode === "create") {
          setupRun = true; await setupStage(store, "reading", userId, { start: true, attempt: 0 });
        }
      }
      const { cards, sources } = await getSources(chatId, messages, userId);
      if (isSpecializedCard(cards, messages)) {
        store.blocked = "This Date Simulator/Storyteller chat belongs to Date Simulator Continuity Engine.";
        store.current = null; store.lastError = ""; store.setupTargetMessageId = null;
        store.setupProgress = null;
        await saveStore(store); await mirror(store); return;
      }
      store.blocked = "";
      const epoch = context.anchor ? `import:${context.anchor.id}` : `cards:${cards.map(card => card.id).join(",")}`;
      const currentFingerprint = fingerprint(sources);
      const openingChanged = !context.anchor && store.sources && store.sources.selectedOpening !== sources.selectedOpening;
      if (store.epoch !== epoch || openingChanged || options.refreshCards && !context.anchor) {
        const { revision, lastRevisionAt, initializationMode, fillMissingSceneDetails, setupNoticeId, setupNoticeShown } = store;
        const setupProgress = setupRun ? store.setupProgress : null;
        store = { ...createStore(chatId), revision, lastRevisionAt, epoch, initializationMode, fillMissingSceneDetails, setupProgress, setupNoticeId, setupNoticeShown };
      }
      // A deleted import anchor must discard all imported state, including its baseline.
      if (context.anchor && (!store.baseline || store.sourceFingerprint !== context.anchor.fingerprint)) {
        store.sources = context.anchor.setup.sources;
        store.sourceFingerprint = context.anchor.fingerprint;
        store.baseline = remapStateSources(context.anchor.setup.initialState, new Map(), context.anchor.id);
        store.initialSetup = { key: "", fingerprint: context.anchor.fingerprint, state: store.baseline };
        store.checkpoints = {};
        store.setupProgress = null;
      } else if (!context.anchor) {
        if (store.sources && store.sourceFingerprint !== currentFingerprint) store.pendingCardFingerprint = currentFingerprint;
        if (!store.sources || !store.baseline) { store.sources = sources; store.sourceFingerprint = currentFingerprint; store.pendingCardFingerprint = ""; }
      }
      if (options.refreshCards && context.anchor) {
        const refreshed = await runTracker(api, { initialize: true, refreshProfiles: true, sources: store.sources,
          previousState: store.baseline, sourceMessageId: context.anchor.id, remainingMs: Math.max(1000, deadline - Date.now()) }, config, userId);
        if (!(await matches(chatId, messages, context.anchor.index))) throw new Error("The imported setup changed during profile refresh.");
        const enriched = structuredClone(store.baseline);
        for (const char of enriched.characters) {
          const extracted = refreshed.characters.find(candidate => candidate.id === char.id);
          if (!extracted || char.controller === "user") continue;
          for (const key of Object.keys(char.profile)) if (char.profile[key] === "Unknown" && extracted.profile[key] !== "Unknown") char.profile[key] = extracted.profile[key];
        }
        if (JSON.stringify(enriched) !== JSON.stringify(store.baseline)) {
          store.baseline = validateState(enriched); store.initialSetup = { ...store.initialSetup, state: structuredClone(store.baseline) };
          store.checkpoints = {}; commitRevision(store);
        }
      }
      store.importable = !context.anchor && !messages.some(message => message.role === "user");
      store.canBegin = Boolean(context.anchor && !turns.length && !messages.some(message => message.role === "user" && /^\/story-begin\b/.test(contentToText(message.content))));
      const narrative = messages.filter(message => ["assistant", "user"].includes(message.role) && !isInitializationNotice(message)
        && !message.metadata?.story_continuity_setup && contentToText(message.content).trim());
      // The opening is only a DOM target: setup controls never become chat content.
      store.setupTargetMessageId = store.baseline ? null : (narrative.find(message => message.role === "assistant") ?? narrative[0])?.id ?? null;
      if (!store.baseline && store.initializationMode !== "create") {
        store.awaitingSetup = true; store.current = null;
        await saveStore(store); await mirror(store);
        return;
      }
      store.awaitingSetup = false;
      if (!context.anchor && !store.baseline && !setupRun) {
        setupRun = true; await setupStage(store, "reading", userId, { start: true, attempt: 0 });
      }
      let prefix = validCheckpointPrefix(store, turns);
      if (options.reprocess && prefix.count && prefix.count === turns.length) {
        delete store.checkpoints[turns.at(-1).key];
        prefix = validCheckpointPrefix(store, turns);
      }
      store.current = prefix.previousState;
      store.checkpoints = prefix.checkpoints;
      store.lastError = "";
      if (setupRun && store.baseline) await setupStage(store, "saving", userId);
      await saveStore(store); await mirror(store); await publish(chatId, userId, options.includePrivate);
      if (setupRun && store.baseline) await setupStage(store, "ready", userId);
      const remaining = () => { const ms = deadline - Date.now(); if (ms < 1000) throw new Error("Reconciliation reached its time budget; completed checkpoints are saved. Reprocess to continue."); return ms; };
      if (!store.baseline) {
        const baseline = await runTracker(api, { initialize: true, sources: store.sources, fillMissingSceneDetails: store.fillMissingSceneDetails,
          sourceMessageId: "card-baseline", remainingMs: remaining(), onProgress: progress => setupStage(store, progress.stage, userId, progress) }, config, userId);
        // Initialization must still refer to the same cards and selected opening.
        const freshMessages = await api.chat.getMessages(chatId);
        const fresh = await getSources(chatId, freshMessages, userId);
        if (fingerprint(fresh.sources) !== currentFingerprint || deleted.has(chatId)) throw new Error("Card or opening changed during initialization; retry on the selected state.");
        await setupStage(store, "saving", userId);
        store.baseline = baseline; store.current = baseline; store.setupTargetMessageId = null; commitRevision(store);
        await saveStore(store); await mirror(store);
        await setupStage(store, "ready", userId);
      }
      let previousState = prefix.previousState ?? store.baseline;
      for (let index = prefix.count; index < turns.length; index++) {
        const turn = turns[index];
        const isOpening = !context.anchor && index === 0 && !turn.user && contentToText(turn.assistant.content) === store.sources.selectedOpening;
        // After generation and repair both fail, do not repeat an unchanged request
        // on every background event. Keep the proven prefix across worker restarts.
        const signature = isOpening ? null : fingerprint({ contract: 1, userId, epoch: store.epoch, sources: store.sourceFingerprint,
          previousState, turn: turn.fingerprint, focusCharacterId: turn.assistant.character_id,
          connectionId: config.connectionId, outputMode: config.outputMode, maxTokens: config.maxTokens, timeoutMs: config.timeoutMs });
        if (signature && store.rejectedTurn?.signature === signature && !options.reprocess && !options.refreshCards) {
          store.lastError = store.rejectedTurn.error + rejectionRetryHint;
          await saveStore(store);
          return;
        }
        store.rejectedTurn = null; trackerAttempt = signature;
        const state = isOpening ? previousState : await runTracker(api, { sources: store.sources, previousState, focusCharacterId: turn.assistant.character_id,
          userText: contentToText(turn.user?.content), assistantText: contentToText(turn.assistant.content),
          sourceMessageId: String(turn.assistant.id), isOpening, remainingMs: remaining() }, config, userId);
        trackerAttempt = null;
        if (!(await matches(chatId, messages, turn.index))) throw new Error("The selected branch changed during tracking; stale output was discarded.");
        store.checkpoints[turn.key] = { fingerprint: turn.fingerprint, state, createdAt: new Date().toISOString() };
        store.current = state; previousState = state; commitRevision(store);
        if (!context.anchor && index === 0 && (!store.initialSetup || store.initialSetup.fingerprint !== turn.fingerprint)) store.initialSetup = { key: turn.key, fingerprint: turn.fingerprint, state: structuredClone(state) };
        await saveStore(store); await mirror(store);
      }
      store.rejectedTurn = null;
      if (store.initialSetup?.key && !turns.some(turn => turn.key === store.initialSetup.key && turn.fingerprint === store.initialSetup.fingerprint)) store.initialSetup = null;
      await saveStore(store);
    } catch (error) {
      store.lastError = String(error?.message ?? error).slice(0, 600);
      if (setupRun && store.setupProgress?.status === "running") await setupStage(store, store.setupProgress.stage, userId, { error: store.lastError });
      if (trackerAttempt && error?.code === "TRACKER_STATE_REJECTED") {
        store.rejectedTurn = { signature: trackerAttempt, error: store.lastError.slice(0, 450) };
        store.lastError = store.rejectedTurn.error + rejectionRetryHint;
      }
      await saveStore(store);
      api.log.warn(`Story continuity update failed: ${store.lastError}`);
    } finally {
      if (initializationNotice) await removeInitializationNotices(store);
      processing.delete(chatId); await publish(chatId, userId, options.includePrivate);
    }
  }
  function enqueue(chatId, operation) {
    const next = (queues.get(chatId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    queues.set(chatId, next);
    next.finally(() => { if (queues.get(chatId) === next) queues.delete(chatId); }).catch(error => api.log.warn(String(error?.message ?? error)));
    return next;
  }
  const schedule = (chatId, options = {}, userId) => { if (userId) users.set(chatId, userId); return enqueue(chatId, () => reconcile(chatId, options, userId ?? users.get(chatId))); };

  async function intercept(messages, context) {
    const config = await loadConfig(), chatId = context?.chatId;
    const stripNotices = (input, stored = []) => stripInitializationNotices(input, stored, noticeIds.get(chatId));
    let clean = stripNotices(messages);
    if (!config.enabled || !chatId || deleted.has(chatId) || required.some(permission => !has(permission))) {
      if (chatId && !deleted.has(chatId) && has("chat_mutation")) clean = stripNotices(clean, await api.chat.getMessages(chatId));
      return clean;
    }
    if (isSpecializedCard([], clean)) {
      clean = stripNotices(clean, await api.chat.getMessages(chatId));
      if (isSpecializedCard([], clean)) return clean;
    }
    await schedule(chatId, {}, context.userId ?? users.get(chatId));
    const store = await loadStore(chatId);
    const selectedMessages = await api.chat.getMessages(chatId);
    clean = stripNotices(clean, selectedMessages);
    if (!store.current || store.blocked) return clean;
    // Revalidate the currently selected prefix even when a tracker update failed.
    const fresh = await getSources(chatId, selectedMessages, context.userId ?? users.get(chatId));
    if (isSpecializedCard(fresh.cards, selectedMessages) || (!store.epoch.startsWith("import:") && store.sources.selectedOpening !== fresh.sources.selectedOpening)) return clean;
    const selectedContext = transcriptContext(selectedMessages);
    if ((selectedContext.anchor ? `import:${selectedContext.anchor.id}` : store.epoch.startsWith("import:") ? "removed-import" : store.epoch) !== store.epoch) return clean;
    const prefix = validCheckpointPrefix(store, listEligibleTurns(selectedMessages, selectedContext));
    const latestAssistant = selectedMessages.findLast(message => message.role === "assistant" && !message.metadata?.story_continuity_setup && !isInitializationNotice(message));
    return prefix.previousState ? injectContinuity(clean, prefix.previousState, store.lastError ? "using last valid checkpoint" : "active", {
      focusCharacterId: context.characterId ?? context.targetCharacterId ?? latestAssistant?.character_id,
      recentText: contentToText(latestAssistant?.content),
      sources: store.sources,
    }) : clean;
  }
  function register() { if (!registered && has("interceptor")) { api.registerInterceptor(intercept, 260); registered = true; } }

  async function inheritFork(payload, userId) {
    const { sourceChatId, forkedChatId, forkedAtMessageId, messageIdMap } = payload ?? {};
    if (!sourceChatId || !forkedChatId || sourceChatId === forkedChatId || !messageIdMap || !messageIdMap[forkedAtMessageId]) return false;
    const map = new Map(Object.entries(messageIdMap));
    if (new Set(map.values()).size !== map.size) return false;
    const source = await loadStore(sourceChatId), existing = await loadStore(forkedChatId);
    if (!source.baseline || existing.baseline) return false;
    const messages = await api.chat.getMessages(forkedChatId);
    const reverse = new Map([...map].map(([from, to]) => [to, from]));
    if (messages.length !== map.size || messages.some(message => !reverse.has(String(message.id)))) return false;
    const sourcePrefix = messages.map(message => ({ ...message, id: reverse.get(String(message.id)) }));
    const sourceContext = transcriptContext(sourcePrefix), context = transcriptContext(messages);
    const originalTurns = listEligibleTurns(sourcePrefix, sourceContext), turns = listEligibleTurns(messages, context);
    const prefix = validCheckpointPrefix(source, originalTurns);
    const next = createStore(forkedChatId);
    next.fillMissingSceneDetails = source.fillMissingSceneDetails;
    next.sources = source.sources;
    next.epoch = source.epoch.startsWith("import:") ? `import:${map.get(source.epoch.slice(7))}` : source.epoch;
    if (next.epoch === "import:undefined") return false;
    next.sourceFingerprint = context.anchor?.fingerprint ?? source.sourceFingerprint;
    next.baseline = remapStateSources(source.baseline, map); next.current = next.baseline;
    for (let index = 0; index < prefix.count; index++) {
      const turn = turns[index], inherited = prefix.checkpoints[originalTurns[index].key];
      if (map.get(String(originalTurns[index].assistant.id)) !== String(turn.assistant.id)) break;
      const state = remapStateSources(inherited.state, map);
      next.checkpoints[turn.key] = { ...inherited, fingerprint: turn.fingerprint, state };
      next.current = state; commitRevision(next);
    }
    const initial = source.initialSetup;
    if (initial?.key) {
      const old = originalTurns.findIndex(turn => turn.key === initial.key && turn.fingerprint === initial.fingerprint);
      if (old >= 0 && next.checkpoints[turns[old].key]) next.initialSetup = { key: turns[old].key, fingerprint: turns[old].fingerprint, state: remapStateSources(initial.state, map) };
    } else if (context.anchor) next.initialSetup = { key: "", fingerprint: context.anchor.fingerprint, state: next.baseline };
    await saveStore(next); await mirror(next); users.set(forkedChatId, userId);
    return true;
  }

  async function scanUnusedStores(userId) {
    const entries = await api.storage.list("chats");
    const candidates = [];
    for (const entry of entries) {
      if (typeof entry !== "string" || !/^[a-zA-Z0-9_-]+\.json$/.test(entry)) continue;
      try {
        const value = JSON.parse(await api.storage.read(`chats/${entry}`));
        if (value.schemaVersion !== 1 || !value.chatId || pathFor(value.chatId) !== `chats/${entry}` || processing.has(value.chatId) || queues.has(value.chatId)) continue;
        if (!value.current && !value.baseline && !Object.keys(value.checkpoints ?? {}).length && !value.revision) candidates.push(`chats/${entry}`);
        else if (has("chats") && await api.chats.get(value.chatId, userId) === null) candidates.push(`chats/${entry}`);
      } catch { /* retain any file whose ownership or orphan status cannot be proved */ }
    }
    return candidates;
  }

  async function handleFrontend(payload, userId) {
    const type = payload?.type;
    if (!type?.startsWith("story_")) return;
    if (type === "story_get_connections") {
      try { send({ type: "story_connections", connections: has("generation") ? await api.connections.list(userId) : [], error: has("generation") ? "" : "Generation permission is required." }, userId); }
      catch (error) { send({ type: "story_connections", connections: [], error: error.message }, userId); }
      return;
    }
    if (type === "story_save_config" || type === "story_set_widget_visibility") {
      const config = normalizeConfig(type === "story_save_config" ? payload.config : { ...await loadConfig(), showStatusWidget: payload.showStatusWidget });
      await api.storage.setJson("config.json", config, { indent: 2 });
      send({ type: "story_config_saved", config }, userId);
      const chatId = requestChat(payload, userId);
      if (chatId) await schedule(chatId, {}, userId); else await publish(null, userId);
      return;
    }
    if (type === "story_scan_cleanup" || type === "story_cleanup_unused") {
      try {
        const candidates = await scanUnusedStores(userId), key = userKey(userId);
        if (type === "story_scan_cleanup") {
          const token = crypto.randomUUID(); cleanupTokens.set(key, { token, expires: Date.now() + 120000, paths: candidates });
          send({ type: "story_cleanup_scan", count: candidates.length, token, message: candidates.length ? `Found ${candidates.length} unused tracking files. Click Delete to confirm.` : "No unused tracking files found." }, userId);
        } else {
          const confirmation = cleanupTokens.get(key); cleanupTokens.delete(key);
          if (!confirmation || confirmation.token !== payload.token || confirmation.expires < Date.now()) throw new Error("Cleanup confirmation expired; scan again.");
          let removed = 0;
          for (const path of candidates.filter(path => confirmation.paths.includes(path))) {
            const value = JSON.parse(await api.storage.read(path));
            await enqueue(value.chatId, async () => {
              const fresh = JSON.parse(await api.storage.read(path));
              if (fresh.chatId !== value.chatId || pathFor(fresh.chatId) !== path || processing.has(fresh.chatId)) return;
              const inert = !fresh.current && !fresh.baseline && !Object.keys(fresh.checkpoints ?? {}).length && !fresh.revision;
              if (inert || has("chats") && await api.chats.get(fresh.chatId, userId) === null) { await api.storage.delete(path); removed++; }
            });
          }
          send({ type: "story_action_result", ok: true, message: `Deleted ${removed} unused tracking files.` }, userId);
        }
      } catch (error) { send({ type: "story_action_result", ok: false, message: error.message }, userId); }
      return;
    }
    const chatId = requestChat(payload, userId);
    if (type === "story_get_status") {
      await publish(chatId, userId, Boolean(payload.includePrivate));
      if (chatId) await schedule(chatId, { includePrivate: Boolean(payload.includePrivate) }, userId);
      return;
    }
    if (!chatId) { send({ type: "story_action_result", ok: false, requestId: payload.requestId, chatId: null, message: "Open the intended character chat first." }, userId); return; }
    try {
      if (type === "story_create_setup") {
        await enqueue(chatId, async () => {
          const config = await loadConfig(), store = await loadStore(chatId);
          if (!config.enabled || required.some(permission => !has(permission))) throw new Error("Enable tracking and grant the required permissions before creating a setup.");
          const messages = await api.chat.getMessages(chatId);
          if (isSpecializedCard([], messages)) throw new Error("Use Date Simulator Continuity Engine for this card.");
          if (transcriptContext(messages).anchor) throw new Error("A saved setup is already loaded.");
          if (selection(userId) !== chatId || generating.has(chatId)) throw new Error("Open the intended chat and wait for the current response to finish.");
          store.initializationMode = "create"; store.awaitingSetup = false; store.lastError = "";
          store.setupProgress = null;
          if (!store.baseline) store.fillMissingSceneDetails = payload.fillMissingSceneDetails === true;
          await saveStore(store);
          // Keep the choice and its attempt in one queue operation so a queued
          // status/event cannot start an extra attempt between them.
          await reconcile(chatId, { retrySetup: true }, userId);
        });
        const store = await loadStore(chatId);
        if (store.lastError || !store.current) throw new Error(store.lastError || store.blocked || "The initial story state could not be created.");
        send({ type: "story_setup_result", chatId, requestId: payload.requestId, ok: true, message: "Initial profiles and story state are ready." }, userId);
      } else if (type === "story_reprocess" || type === "story_refresh_cards") {
        await schedule(chatId, { reprocess: type === "story_reprocess", refreshCards: type === "story_refresh_cards", includePrivate: payload.includePrivate }, userId);
        const store = await loadStore(chatId);
        if (store.lastError || store.blocked) throw new Error(store.lastError || store.blocked);
        send({ type: "story_action_result", chatId, ok: true, message: type === "story_reprocess" ? "Latest turn reprocessed." : "Card profiles refreshed and selected history reconciled." }, userId);
      } else if (type === "story_export_setup") {
        await enqueue(chatId, async () => {
          const messages = await api.chat.getMessages(chatId), store = await loadStore(chatId);
          if (store.blocked) throw new Error(store.blocked);
          const context = transcriptContext(messages);
          const setup = exportInitialSetup(store, listEligibleTurns(messages, context), context);
          if (selection(userId) !== chatId) throw new Error("Chat changed while exporting.");
          send({ type: "story_setup_result", chatId, requestId: payload.requestId, ok: true, fileText: JSON.stringify(setup, null, 2), message: "Original starting state ready to save." }, userId);
        });
      } else if (type === "story_import_setup") {
        const setup = validateSetupFile(payload.fileText);
        await enqueue(chatId, async () => {
          const config = await loadConfig(), store = await loadStore(chatId);
          if (!config.enabled || required.some(permission => !has(permission))) throw new Error("Enable tracking and grant the required permissions before importing.");
          if (store.initializationMode === "create" && !store.baseline && !store.lastError) throw new Error("Setup creation is in progress; wait for it to finish before importing.");
          const messages = await api.chat.getMessages(chatId), prefix = fingerprint(messages);
          const { cards } = await getSources(chatId, messages, userId);
          if (isSpecializedCard(cards, messages) || isSpecializedCard(setup.sources.cards)) throw new Error("Use Date Simulator Continuity Engine for specialized setups.");
          if (messages.some(message => message.role === "user" || message.metadata?.story_continuity_setup) || generating.has(chatId)) throw new Error("Import requires a fresh chat with no user turns or response in progress.");
          if (selection(userId) !== chatId || fingerprint(await api.chat.getMessages(chatId)) !== prefix) throw new Error("Selected chat changed during import.");
          await api.chat.appendMessage(chatId, { role: "assistant", content: IMPORT_LOADED_TEXT, metadata: { story_continuity_setup: setup } });
          // The appended anchor is authority; reconstruction remains possible after sidecar loss.
          store.current = null; await saveStore(store);
        });
        await schedule(chatId, {}, userId);
        send({ type: "story_setup_result", chatId, requestId: payload.requestId, ok: true, message: "Setup loaded. Select Begin Story." }, userId);
      } else if (type === "story_begin") {
        if (beginning.has(chatId) || required.some(permission => !has(permission)) || !(await loadConfig()).enabled) throw new Error("Begin Story is unavailable while another begin is running or required tracking permissions are missing.");
        const messages = await api.chat.getMessages(chatId), context = transcriptContext(messages);
        if (!context.anchor || listEligibleTurns(messages, context).length || generating.has(chatId)) throw new Error("Begin Story requires a loaded setup before play starts.");
        if (messages.some(message => message.role === "user" && /^\/story-begin\b/.test(contentToText(message.content)))) throw new Error("The starting scene has already been presented.");
        // Begin invokes generation outside our queue; its interceptor can safely reconcile.
        beginning.add(chatId);
        try { await api.chat.appendMessage(chatId, { role: "user", content: "/story-begin\nPresent the current observable starting scene from saved continuity. Do not advance time, recast characters, or reveal private information.", metadata: { story_continuity_observation: true } }, { triggerGeneration: true }); }
        finally { beginning.delete(chatId); }
      }
    } catch (error) {
      if (type === "story_create_setup") {
        try {
          const store = await loadStore(chatId);
          if (!store.current && !store.blocked && store.setupProgress?.status !== "failed") {
            store.lastError = String(error?.message ?? error).slice(0, 600);
            await setupStage(store, "setup", userId, { error: store.lastError, start: true, attempt: 0 });
          }
        } catch { api.log.warn("Initial setup failure details could not be saved."); }
      }
      send({ type: type.includes("setup") ? "story_setup_result" : "story_action_result", chatId, requestId: payload.requestId, ok: false, message: String(error?.message ?? error) }, userId);
    }
  }

  register();
  api.onFrontendMessage(handleFrontend);
  api.on("CHAT_SWITCHED", (payload, userId) => { const chatId = adopt(payload?.chatId, userId); return chatId ? schedule(chatId, {}, userId) : publish(null, userId); });
  for (const name of ["MESSAGE_SENT", "MESSAGE_EDITED", "MESSAGE_DELETED", "MESSAGE_SWIPED", "SWIPE_EDITED"]) api.on(name, (payload, userId) => {
    if (!payload?.chatId) return;
    const id = payload.messageId ?? payload.message?.id;
    if (isInitializationNotice(payload.message) || id != null && noticeIds.get(payload.chatId)?.has(String(id))) return;
    return schedule(payload.chatId, {}, userId);
  });
  for (const name of ["GENERATION_STARTED", "GENERATION_ENDED", "GENERATION_STOPPED"]) api.on(name, payload => {
    if (!payload?.chatId) return;
    if (name === "GENERATION_STARTED") generating.add(payload.chatId); else generating.delete(payload.chatId);
  });
  api.on("CHAT_FORKED", (payload, userId) => {
    if (!payload?.forkedChatId) return;
    const sourcePending = queues.get(payload.sourceChatId) ?? Promise.resolve();
    return enqueue(payload.forkedChatId, async () => { await sourcePending.catch(() => undefined); await inheritFork(payload, userId); await reconcile(payload.forkedChatId, {}, userId); });
  });
  api.on("CHAT_DELETED", payload => {
    const chatId = payload?.id ?? payload?.chatId;
    if (!chatId) return;
    deleted.add(chatId);
    noticeIds.delete(chatId);
    return enqueue(chatId, () => api.storage.delete(pathFor(chatId)));
  });
  api.permissions.onChanged(({ permission, granted }) => { if (permission === "interceptor" && granted) register(); });
  return { handleFrontend, schedule, reconcile, intercept, status, loadStore, pathFor, inheritFork, scanUnusedStores };
}

if (typeof spindle !== "undefined") createStoryEngine(spindle);
