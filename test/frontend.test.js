import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { setup } from "../src/frontend.js";
import { publicTrackerSnapshot } from "../src/schemas.js";
import { fixtureState } from "./fixtures.js";

function mountHarness(native = false) {
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", { url: "http://localhost" });
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const events = new Map(), sent = [], destroyed = [], mounts = [], widgets = [], injections = [], bubbles = new Map();
  let activated = 0;
  let backend;
  const tab = { root: document.querySelector("main"), destroy() {}, setBadge() {}, activate() { activated++; }, onActivate: () => () => {} };
  const components = {};
  if (native) for (const method of ["mountSelect", "mountSwitch", "mountCheckbox", "mountNumericInput", "mountBadge"]) {
    components[method] = (slot, options) => {
      const input = document.createElement(method === "mountSelect" ? "select" : method === "mountBadge" ? "span" : "input");
      input.dataset.native = method;
      if (method === "mountSwitch" || method === "mountCheckbox") input.type = "checkbox";
      if (method === "mountNumericInput") input.type = "number";
      input.setAttribute("aria-label", options.ariaLabel ?? options.label ?? "");
      const update = props => {
        if (props.options) { input.replaceChildren(); for (const option of props.options) { const item = document.createElement("option"); item.value = option.value; item.textContent = option.label; input.append(item); } }
        if (Object.hasOwn(props, "checked")) input.checked = props.checked;
        if (Object.hasOwn(props, "value")) input.value = props.value;
        if (Object.hasOwn(props, "text")) input.textContent = props.text;
      };
      update(options); input.addEventListener("change", () => options.onChange?.(input.type === "checkbox" ? input.checked : input.value)); slot.append(input);
      const handle = { getValue: () => input.type === "checkbox" ? input.checked : input.value, update, destroy: () => destroyed.push(method) };
      mounts.push(handle); return handle;
    };
  }
  const ctx = { components, ui: { registerDrawerTab: options => { assert.equal(options.shortName, "Story Continuity"); return tab; },
    createFloatWidget() { const root = document.createElement("div"); document.body.append(root); const widget = { root, destroy() { root.remove(); }, onDragEnd() { return () => {}; } }; widgets.push(widget); return widget; } },
    dom: { addStyle: css => { const style = document.createElement("style"); style.textContent = css; document.head.append(style); return () => style.remove(); },
      findMessageElement: id => bubbles.get(id) ?? null,
      inject(target, html) { const wrapper = document.createElement("div"); wrapper.innerHTML = html; target.append(wrapper); injections.push(wrapper); return wrapper; },
      uninject: wrapper => wrapper.remove(), cleanup() {} },
    sendToBackend: payload => sent.push(payload), onBackendMessage: handler => { backend = handler; return () => {}; },
    events: { on: (name, handler) => { events.set(name, handler); return () => {}; } }, getActiveChat: () => ({ chatId: "chat" }), ready() {}, uploads: { pickFile: async () => [] } };
  const destroy = setup(ctx);
  const status = overrides => backend({ type: "story_status", chatId: "chat",
    code: "active", level: "green", text: "Story continuity is current.", revision: 2, lastRevisionAt: "2026-10-13T16:00:00Z", snapshot: publicTrackerSnapshot(fixtureState()), canImport: true, canExport: true, canBegin: false, ...overrides,
    config: { enabled: true, showStatusWidget: false, connectionId: "", outputMode: "auto", maxTokens: 6144, timeoutMs: 120000, ...overrides?.config } });
  const button = label => [...document.querySelectorAll("button")].find(button => button.textContent === label);
  const message = id => { const bubble = document.createElement("article"); document.body.prepend(bubble); bubbles.set(id, bubble); return bubble; };
  return { dom, ctx, sent, status, backend: payload => backend(payload), events, button, mounts, destroyed, widgets, injections, message, activated: () => activated,
    restore: () => { destroy(); dom.window.close(); globalThis.window = before.window; globalThis.document = before.document; } };
}

for (const native of [false, true]) test(`drawer ${native ? "native" : "fallback"} controls show observable facts and hide private state`, () => {
  const h = mountHarness(native);
  try {
    h.status(); assert.ok(document.body.textContent.includes("Blue coat")); assert.ok(document.body.textContent.includes("Side door locked"));
    assert.ok(!document.body.textContent.includes("Lantern Guild")); assert.ok(!document.body.textContent.includes("Hidden tunnel"));
    assert.equal(h.button("Import Setup — Choose File").disabled, false);
    const checkbox = document.querySelector('[aria-label="Show Private Tracker State"]'); checkbox.checked = true; checkbox.dispatchEvent(new window.Event("change"));
    assert.equal(h.sent.at(-1).includePrivate, true);
    h.status({ privateStateIncluded: true, privateState: fixtureState() }); assert.ok(document.body.textContent.includes("Lantern Guild"));
    checkbox.checked = false; checkbox.dispatchEvent(new window.Event("change")); assert.ok(!document.body.textContent.includes("Lantern Guild"));
    h.status({ chatId: "other", text: "WRONG CHAT", privateStateIncluded: true, privateState: fixtureState() }); assert.ok(!document.body.textContent.includes("WRONG CHAT"));
  } finally { h.restore(); }
  if (native) assert.equal(h.destroyed.length, h.mounts.length);
});
test("drawer dates omit years and exact times show AM/PM with narrative descriptions", () => {
  const h = mountHarness();
  try {
    const snapshot = publicTrackerSnapshot(fixtureState());
    Object.assign(snapshot.world, { date: "2031-10-17 (Fall)", time: "14:54" });
    h.status({ snapshot });
    const world = [...document.querySelectorAll(".sce-record")].find(record => record.querySelector("h4").textContent === "World and current scene");
    assert.ok(world.textContent.includes("October 17 (Fall)")); assert.ok(world.textContent.includes("02:54 PM (Afternoon)"));
    assert.ok(!world.textContent.includes("2031")); assert.equal(snapshot.world.time, "14:54");
    Object.assign(snapshot.world, { date: "Fall", time: "Late afternoon" }); h.status({ snapshot });
    assert.ok(document.body.textContent.includes("Fall")); assert.ok(document.body.textContent.includes("Late afternoon"));
  } finally { h.restore(); }
});

test("drawer displays age/gender and provides a scoped action for older chats", () => {
  const h = mountHarness();
  try {
    const state = fixtureState(); Object.assign(state.characters[0].profile, { age: "Early thirties", gender: "Woman" });
    h.status({ snapshot: publicTrackerSnapshot(state) });
    const record = [...document.querySelectorAll(".sce-record")].find(node => node.querySelector("h4")?.textContent.includes("Ada"));
    assert.ok(record.textContent.includes("AgeEarly thirties")); assert.ok(record.textContent.includes("GenderWoman"));
    assert.ok(!record.textContent.includes("Lantern Guild"));
    const button = h.button("Fill Missing Age / Gender"); assert.equal(button.disabled, false); button.click();
    assert.equal(h.sent.at(-1).type, "story_fill_identity"); assert.equal(h.sent.at(-1).chatId, "chat");
    h.status({ processing: true }); assert.equal(button.disabled, true);
    h.status({ snapshot: publicTrackerSnapshot(fixtureState()) });
    const blank = [...document.querySelectorAll(".sce-record")].find(node => node.querySelector("h4")?.textContent.includes("Ada"));
    assert.ok(![...blank.querySelectorAll("dt")].some(node => ["Age", "Gender"].includes(node.textContent)));
  } finally { h.restore(); }
});

test("drawer preserves unsaved settings and sends one concrete settings payload", () => {
  const h = mountHarness();
  try {
    h.status(); const tokens = document.querySelector('[aria-label="Maximum tracker output tokens"]');
    tokens.value = "9000"; tokens.dispatchEvent(new window.Event("change")); h.status({ revision: 3 }); assert.equal(tokens.value, "9000");
    h.button("Save Settings").click(); const payload = h.sent.at(-1); assert.equal(payload.type, "story_save_config"); assert.equal(payload.config.maxTokens, 9000); assert.equal(payload.config.timeoutMs, 120000);
  } finally { h.restore(); }
});

test("tracker diagnostics require private inspection, render as text and clear on hide or navigation", () => {
  const h = mountHarness();
  try {
    const trackerInfo = { outputMode: "plain", provider: "test", model: "model", lastAttemptAt: 100, outcome: "failed", retryPaused: true, pendingMessageId: "a1", lastTrackedMessageId: "a0" };
    h.status({ code: "degraded", trackerInfo });
    assert.match(document.body.textContent, /prompt-only JSON/); assert.match(document.body.textContent, /Showing the saved failure for message a1/);
    const checkbox = document.querySelector('[aria-label="Show Private Tracker State"]'); checkbox.checked = true; checkbox.dispatchEvent(new window.Event("change"));
    h.status({ code: "degraded", trackerInfo, privateStateIncluded: true, trackerDiagnostics: { attempts: [{ excerpt: '<script>PRIVATE_EXCERPT</script>' }] } });
    assert.ok(document.body.textContent.includes("PRIVATE_EXCERPT")); assert.equal(document.querySelectorAll("script").length, 0);
    checkbox.checked = false; checkbox.dispatchEvent(new window.Event("change"));
    assert.ok(!document.body.textContent.includes("PRIVATE_EXCERPT"));
    checkbox.checked = true; checkbox.dispatchEvent(new window.Event("change"));
    h.status({ trackerInfo, privateStateIncluded: true, trackerDiagnostics: { attempts: [{ excerpt: "PRIVATE_EXCERPT" }] } });
    h.events.get("CHAT_SWITCHED")({ chatId: "other" }); assert.ok(!document.body.textContent.includes("PRIVATE_EXCERPT"));
  } finally { h.restore(); }
});

test("the drawer shows validated initial profiles when world fails and labels them as an incomplete preview", () => {
  const h = mountHarness();
  try {
    const snapshot = publicTrackerSnapshot(fixtureState()); snapshot.world.sceneStatus = "Unavailable — needs repair";
    const preview = { snapshot, unavailableFields: ["world.sceneStatus"] };
    h.status({ code: "degraded", text: "Initial setup stopped.", snapshot: null, setupPreview: preview, canExport: false });
    assert.match(document.body.textContent, /Setup incomplete — showing validated profiles/);
    for (const value of ["Ada", "Blue coat", "Rain", "Unavailable — needs repair", "world.sceneStatus"]) assert.ok(document.body.textContent.includes(value), value);
    assert.ok(!document.body.textContent.includes("No tracked scene is available yet"));
    assert.ok(!document.body.textContent.includes("Lantern Guild"));
    const checkbox = document.querySelector('[aria-label="Show Private Tracker State"]'); checkbox.checked = true; checkbox.dispatchEvent(new window.Event("change"));
    h.status({ code: "degraded", snapshot: null, setupPreview: preview, privateStateIncluded: true, privateState: null, setupPreviewState: fixtureState() });
    assert.ok(document.body.textContent.includes("Lantern Guild")); assert.ok(document.body.textContent.includes("Incomplete setup preview"));
    checkbox.checked = false; checkbox.dispatchEvent(new window.Event("change")); assert.ok(!document.body.textContent.includes("Lantern Guild"));
    h.events.get("CHAT_SWITCHED")({ chatId: "other" }); assert.ok(!document.body.textContent.includes("Blue coat"));
    assert.ok(!document.body.textContent.includes("Setup incomplete — showing validated profiles"));
  } finally { h.restore(); }
});

test("a routine world failure keeps the committed snapshot visible instead of replacing it with a setup preview", () => {
  const h = mountHarness();
  try {
    h.status({ code: "degraded", text: "world.sceneStatus contains an invalid choice", setupPreview: null });
    assert.ok(document.body.textContent.includes("Ada")); assert.ok(document.body.textContent.includes("Blue coat"));
    assert.ok(!document.body.textContent.includes("No tracked scene is available yet"));
  } finally { h.restore(); }
});
test("chat navigation clears private display and rejects delayed setup responses", () => {
  const h = mountHarness();
  try {
    h.status(); h.button("Export Initial Setup").click(); const request = h.sent.at(-1);
    h.events.get("CHAT_SWITCHED")({ chatId: null });
    h.backend({ type: "story_setup_result", chatId: "chat", requestId: request.requestId, ok: true, fileText: "PRIVATE FILE", message: "LATE EXPORT" });
    assert.ok(!document.body.textContent.includes("LATE EXPORT")); assert.equal(h.button("Download JSON File").hidden, true);
    h.status({ text: "Late chat status" }); assert.ok(!document.body.textContent.includes("Late chat status"));
  } finally { h.restore(); }
});
test("cleanup sends the confirmation token returned by the scan", () => {
  const h = mountHarness();
  try {
    h.status(); h.button("Clean Unused Tracking Files").click(); assert.equal(h.sent.at(-1).type, "story_scan_cleanup");
    h.backend({ type: "story_cleanup_scan", count: 3, token: "confirm", message: "Found 3 unused files" }); h.button("Delete 3 Unused Files").click();
    assert.equal(h.sent.at(-1).token, "confirm"); assert.equal(h.sent.at(-1).type, "story_cleanup_unused");
  } finally { h.restore(); }
});

function showStartup(h, overrides = {}) {
  h.status({ code: "setup", level: "amber", text: "Choose Import Saved Setup or Create From Character Card.", revision: 0,
    snapshot: null, canCreate: true, canImport: true, canExport: false, awaitingSetup: true, setupTargetMessageId: "opening", ...overrides });
}
test("startup controls attach to the opening and retire without removing its story content", () => {
  const h = mountHarness();
  try {
    const bubble = h.message("opening"); bubble.append("Ada waits beneath the platform clock."); showStartup(h); showStartup(h);
    assert.equal(h.injections.length, 1);
    const buttons = bubble.querySelectorAll("button"); assert.deepEqual([...buttons].map(button => button.textContent), ["Import Saved Setup", "Create From Character Card"]);
    assert.ok(bubble.textContent.includes("Load saved profiles and starting scene."));
    assert.ok(bubble.textContent.includes("Build profiles and scene from this card."));
    for (const button of buttons) {
      assert.ok(document.getElementById(button.getAttribute("aria-describedby")));
      assert.ok(button.classList.contains("sce-primary"));
    }
    buttons[1].click(); buttons[1].click();
    const requests = h.sent.filter(payload => payload.type === "story_create_setup"); assert.equal(requests.length, 1);
    assert.equal(requests[0].fillMissingSceneDetails, false);
    assert.equal(requests[0].chatId, "chat"); assert.equal(buttons[0].disabled, true); assert.equal(buttons[1].disabled, true);
    showStartup(h, { code: "processing", processing: true, canCreate: false, canImport: false });
    assert.equal(bubble.querySelectorAll("button").length, 2);
    h.backend({ type: "story_setup_result", chatId: "chat", requestId: requests[0].requestId, ok: true, message: "Ready." });
    h.status({ canCreate: false, setupTargetMessageId: null });
    assert.equal(bubble.querySelectorAll("button").length, 0); assert.equal(h.button("Create From Character Card").hidden, true);
    assert.equal(bubble.querySelector(".sce-inline-setup"), null);
    assert.equal(bubble.textContent, "Ada waits beneath the platform clock.");
    showStartup(h); assert.ok(!document.body.textContent.includes("Ready."));
    assert.ok(document.body.textContent.includes("Import a saved starting state or create one from the character card."));
  } finally { h.restore(); }
});

test("scene detail choices sync across setup controls, survive status updates and reset on navigation", () => {
  const h = mountHarness();
  try {
    const bubble = h.message("opening"); showStartup(h);
    const inline = bubble.querySelector('[aria-label="Fill missing scene details"]');
    const drawer = document.querySelector('.sce-panel [aria-label="Fill missing scene details"]');
    assert.equal(inline.checked, false); assert.equal(drawer.checked, false);
    assert.ok(bubble.textContent.includes("Auto-fill missing date, time, weather, and outfits."));
    assert.ok(bubble.textContent.includes("Minor grooming, atmosphere, and mild mood."));
    assert.ok(!bubble.textContent.includes("Outfit, minor grooming"));
    inline.checked = true; inline.dispatchEvent(new window.Event("change"));
    showStartup(h); assert.equal(inline.checked, true); assert.equal(drawer.checked, true);
    drawer.checked = false; drawer.dispatchEvent(new window.Event("change")); assert.equal(inline.checked, false);
    drawer.checked = true; drawer.dispatchEvent(new window.Event("change"));
    h.button("Create From Character Card").click();
    assert.equal(h.sent.at(-1).fillMissingSceneDetails, true); assert.equal(inline.disabled, true); assert.equal(drawer.disabled, true);
    h.status({ canCreate: false, setupTargetMessageId: null }); assert.equal(drawer.closest('.sce-scene-options').hidden, true);
    h.events.get("CHAT_SWITCHED")({ chatId: "other" });
    showStartup(h, { chatId: "other" }); assert.equal(drawer.checked, false);
    h.events.get("CHAT_SWITCHED")({ chatId: "chat" });
    showStartup(h, { fillMissingSceneDetails: true }); assert.equal(drawer.checked, true);
  } finally { h.restore(); }
});

test("inline and drawer import open the picker synchronously and cancel without a setup request", async () => {
  for (const entry of ["inline", "drawer"]) {
    const h = mountHarness();
    try {
      const bubble = h.message("opening");
      if (entry === "inline") showStartup(h); else h.status();
      const controls = entry === "inline" ? [...bubble.querySelectorAll("button")] : [h.button("Import Setup — Choose File")];
      let called = false; h.ctx.uploads.pickFile = async () => { called = true; return []; };
      controls[0].click(); assert.equal(called, true);
      assert.ok(controls.every(button => button.disabled));
      await Promise.resolve();
      assert.ok(controls.every(button => !button.disabled));
      assert.equal(h.sent.filter(payload => ["story_import_setup", "story_create_setup"].includes(payload.type)).length, 0);
    } finally { h.restore(); }
  }
});

test("backend setup status restores progress and retry controls", () => {
  const h = mountHarness();
  try {
    const bubble = h.message("opening");
    showStartup(h, { code: "processing", processing: true, canCreate: false, canImport: false });
    assert.ok(bubble.textContent.includes("Preparing profiles and starting state"));
    assert.ok([...bubble.querySelectorAll("button")].every(button => button.disabled));
    showStartup(h, { code: "degraded", text: "PRIVATE_DIAGNOSTIC", processing: false });
    assert.ok(bubble.textContent.includes("Setup paused. Open Story Continuity when ready."));
    assert.ok(!bubble.textContent.includes("profile created"));
    assert.ok(!bubble.textContent.includes("PRIVATE_DIAGNOSTIC"));
    assert.ok([...bubble.querySelectorAll("button")].every(button => !button.disabled));
  } finally { h.restore(); }
});

test("inline setup keeps failures quiet while drawer details, retry and progress timers remain available", t => {
  let now = 100000, sequence = 0; const intervals = new Map();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", callback => { intervals.set(++sequence, callback); return sequence; });
  t.mock.method(globalThis, "clearInterval", id => intervals.delete(id));
  const h = mountHarness();
  try {
    const bubble = h.message("opening");
    const progress = { stage: "generating", status: "running", startedAt: 90000, updatedAt: now, attempt: 1, elapsedMs: 10000, error: "" };
    showStartup(h, { code: "processing", processing: true, canCreate: false, canImport: false, setupProgress: progress });
    const inline = bubble.querySelector('.sce-setup-progress'), drawer = document.querySelector('.sce-panel .sce-setup-progress');
    assert.ok(inline.textContent.includes("Generating profiles and starting state"));
    assert.equal(inline.querySelector('[aria-label="Elapsed setup time"]').textContent, "10s elapsed"); assert.equal(intervals.size, 1);
    const requests = h.sent.length; now += 2000; for (const tick of intervals.values()) tick();
    assert.equal(inline.querySelector('[aria-label="Elapsed setup time"]').textContent, "12s elapsed"); assert.equal(h.sent.length, requests);
    showStartup(h, { code: "processing", processing: true, canCreate: false, setupProgress: { ...progress, stage: "repairing", attempt: 2, elapsedMs: 12000 } });
    assert.ok(inline.textContent.includes("Repairing rejected output")); assert.equal(intervals.size, 1);
    const failure = { ...progress, status: "failed", stage: "validating", attempt: 2, elapsedMs: 12000, finishedAt: now, error: 'Invalid outfit <img src="x" onerror="alert(1)">' };
    showStartup(h, { code: "degraded", setupProgress: failure });
    const details = drawer.querySelector('details'), inlineDetails = inline.querySelector('details');
    assert.ok(inline.textContent.includes("Setup paused. Open Story Continuity when ready."));
    assert.equal(inline.dataset.status, "paused"); assert.equal(inlineDetails.hidden, true);
    assert.equal(inline.querySelector('[aria-label="Elapsed setup time"]').hidden, true);
    assert.equal(inline.querySelector('pre').textContent, "");
    assert.ok(!inline.textContent.includes("Failed while")); assert.ok(!inline.textContent.includes("Invalid outfit"));
    assert.ok(drawer.textContent.includes("Failed while validating repaired response")); assert.equal(details.open, false); assert.equal(details.hidden, false);
    assert.equal(drawer.querySelector('img'), null); assert.equal(intervals.size, 0);
    details.open = true; showStartup(h, { code: "degraded", setupProgress: failure }); assert.equal(details.open, true);
    showStartup(h, { code: "degraded", setupProgress: failure, config: { showStatusWidget: true }, setupPreview: { snapshot: publicTrackerSnapshot(fixtureState()), unavailableFields: ["world.sceneStatus"] } });
    assert.equal(inline.dataset.status, "profile");
    assert.ok(inline.textContent.includes("Character profile created. Complete setup in Story Continuity."));
    assert.ok(!bubble.textContent.includes("Failed while")); assert.ok(!bubble.textContent.includes("Invalid outfit"));
    assert.equal(inlineDetails.hidden, true); assert.equal(details.open, true);
    assert.equal(h.widgets.at(-1).root.querySelector('button').dataset.state, "attention");
    assert.equal(h.button("Retry Setup").disabled, false); h.button("Retry Setup").click();
    const retry = h.sent.at(-1); assert.equal(retry.type, "story_create_setup"); assert.equal(retry.chatId, "chat");
    h.backend({ type: "story_setup_result", chatId: "chat", requestId: retry.requestId, ok: false, message: failure.error });
    assert.ok(document.body.textContent.includes("Expand error details, then select Retry Setup"));
    now += 1000;
    showStartup(h, { code: "processing", processing: true, canCreate: false, setupProgress: { ...progress, stage: "reading", startedAt: now, elapsedMs: 0 } });
    assert.equal(details.open, false); assert.equal(details.hidden, true); assert.equal(inline.querySelector('pre').textContent, "");
    assert.equal(inline.dataset.status, "running"); assert.equal(inline.querySelector('[aria-label="Elapsed setup time"]').hidden, false);
    h.status({ canCreate: false, setupTargetMessageId: null, setupProgress: { ...progress, status: "ready", stage: "ready", elapsedMs: 20000, finishedAt: now } });
    assert.equal(bubble.querySelector('.sce-setup-progress'), null); assert.ok(drawer.textContent.includes("Initial setup ready"));
    assert.equal(drawer.querySelector('[aria-label="Elapsed setup time"]').textContent, "Completed in 20s"); assert.equal(intervals.size, 0);
    showStartup(h, { setupProgress: { ...progress, stage: "reading", startedAt: now, elapsedMs: 0 } }); assert.equal(intervals.size, 1);
    h.events.get("CHAT_SWITCHED")({ chatId: null }); assert.equal(intervals.size, 0); assert.equal(drawer.hidden, true); assert.equal(drawer.querySelector('pre').textContent, "");
    h.status({ setupProgress: failure }); assert.equal(drawer.hidden, true);
  } finally { h.restore(); }
  assert.equal(intervals.size, 0);
});

test("inline import shares the drawer picker and ignores files selected after navigation", async () => {
  const h = mountHarness();
  try {
    const bubble = h.message("opening"); showStartup(h);
    h.ctx.uploads.pickFile = async () => [{ bytes: new TextEncoder().encode('{"saved":"setup"}') }];
    bubble.querySelector("button").click(); await Promise.resolve();
    const request = h.sent.find(payload => payload.type === "story_import_setup"); assert.equal(request.fileText, '{"saved":"setup"}');
    h.backend({ type: "story_setup_result", chatId: "chat", requestId: request.requestId, ok: false, message: "PRIVATE_BACKEND_DIAGNOSTIC" });
    showStartup(h);
    assert.ok(!bubble.textContent.includes("PRIVATE_BACKEND_DIAGNOSTIC")); assert.ok(!bubble.querySelector("button").disabled);
    let choose; h.ctx.uploads.pickFile = () => new Promise(resolve => { choose = resolve; });
    bubble.querySelector("button").click(); h.events.get("CHAT_SWITCHED")({ chatId: "other" });
    choose([{ bytes: new TextEncoder().encode("STALE FILE") }]); await Promise.resolve();
    assert.equal(h.sent.filter(payload => payload.type === "story_import_setup").length, 1);
    assert.equal(bubble.querySelectorAll("button").length, 0);
  } finally { h.restore(); }
});

test("startup choices attach when their virtualized message becomes visible", () => {
  const h = mountHarness();
  try {
    showStartup(h); assert.equal(h.injections.length, 0);
    const bubble = h.message("opening"); h.events.get("CHARACTER_MESSAGE_RENDERED")({ chatId: "chat", messageId: "opening" });
    assert.equal(bubble.querySelectorAll("button").length, 2);
    h.events.get("CHARACTER_MESSAGE_RENDERED")({ chatId: "chat", messageId: "opening" });
    assert.equal(h.injections.length, 1);
    h.events.get("CHAT_SWITCHED")({ chatId: null }); assert.equal(bubble.querySelectorAll("button").length, 0);
  } finally { h.restore(); }
});

test("enabled floating widget is visible before a snapshot and updates through setup, generation and readiness", () => {
  const h = mountHarness();
  try {
    showStartup(h, { config: { showStatusWidget: true } });
    assert.equal(h.widgets.length, 1);
    const icon = h.widgets[0].root.querySelector("button");
    assert.equal(icon.dataset.state, "setup"); assert.ok(icon.title.includes("Choose Import"));
    icon.click(); assert.equal(h.activated(), 1);
    showStartup(h, { config: { showStatusWidget: true }, code: "processing", processing: true, canImport: false, canCreate: false, text: "Generating initial state…" });
    assert.equal(h.widgets.length, 1); assert.equal(icon.dataset.state, "processing");
    h.status({ config: { showStatusWidget: true } }); assert.equal(icon.dataset.state, "active");
    const preference = document.querySelector('[aria-label="Show Widget"]'); preference.checked = false; preference.dispatchEvent(new window.Event("change"));
    assert.equal(h.widgets[0].root.isConnected, false); assert.equal(h.sent.at(-1).showStatusWidget, false);
  } finally { h.restore(); }
});

test("widget follows the active chat immediately and respects Home, disabled preference and specialized routing", () => {
  const h = mountHarness();
  try {
    showStartup(h, { config: { showStatusWidget: true } }); h.events.get("CHAT_SWITCHED")({ chatId: "other" });
    const widget = h.widgets.at(-1); assert.equal(widget.root.isConnected, true);
    assert.equal(widget.root.querySelector("button").title, "Loading chat continuity…");
    h.status({ text: "WRONG CHAT", config: { showStatusWidget: true } }); assert.ok(!widget.root.querySelector("button").title.includes("WRONG"));
    h.events.get("CHAT_SWITCHED")({ chatId: null }); assert.equal(widget.root.isConnected, false);
    h.events.get("CHAT_SWITCHED")({ chatId: "chat" }); h.status({ code: "specialized", snapshot: null, config: { showStatusWidget: true } });
    assert.equal(h.widgets.at(-1).root.isConnected, false);
    h.status({ code: "setup", snapshot: null, config: { showStatusWidget: false } });
    const count = h.widgets.length; h.events.get("CHAT_SWITCHED")({ chatId: "third" }); assert.equal(h.widgets.length, count);
  } finally { h.restore(); }
});
