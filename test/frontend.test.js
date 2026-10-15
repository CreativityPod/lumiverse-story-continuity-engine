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
  let backend, activate;
  const tab = { root: document.querySelector("main"), destroy() {}, setBadge() {}, activate() { activated++; }, onActivate: handler => { activate = handler; return () => {}; } };
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
  const status = overrides => backend({ type: "story_status", chatId: "chat", config: { enabled: true, showStatusWidget: false, connectionId: "", outputMode: "auto", maxTokens: 6144, timeoutMs: 120000 },
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
test("drawer preserves unsaved settings and sends one concrete settings payload", () => {
  const h = mountHarness();
  try {
    h.status(); const tokens = document.querySelector('[aria-label="Maximum tracker output tokens"]');
    tokens.value = "9000"; tokens.dispatchEvent(new window.Event("change")); h.status({ revision: 3 }); assert.equal(tokens.value, "9000");
    h.button("Save Settings").click(); const payload = h.sent.at(-1); assert.equal(payload.type, "story_save_config"); assert.equal(payload.config.maxTokens, 9000); assert.equal(payload.config.timeoutMs, 120000);
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
test("import picker runs directly from a click and cancel creates no import request", async () => {
  const h = mountHarness();
  try {
    h.status(); const count = h.sent.length; h.button("Import Setup — Choose File").click(); await Promise.resolve();
    assert.equal(h.sent.length, count);
    h.backend({ type: "story_cleanup_scan", count: 3, token: "confirm", message: "Found 3 unused files" }); h.button("Delete 3 Unused Files").click();
    assert.equal(h.sent.at(-1).token, "confirm"); assert.equal(h.sent.at(-1).type, "story_cleanup_unused");
  } finally { h.restore(); }
});

function showStartup(h, overrides = {}) {
  h.status({ code: "setup", level: "amber", text: "Choose Import Saved Setup or Create From Character Card.", revision: 0,
    snapshot: null, canCreate: true, canImport: true, canExport: false, awaitingSetup: true, setupNoticeId: "notice", ...overrides });
}
test("startup message buttons send one explicit creation request and retire when state is ready", () => {
  const h = mountHarness();
  try {
    const bubble = h.message("notice"); showStartup(h); showStartup(h);
    assert.equal(h.injections.length, 1);
    const buttons = bubble.querySelectorAll("button"); assert.deepEqual([...buttons].map(button => button.textContent), ["Import Saved Setup", "Create From Character Card"]);
    assert.ok(bubble.textContent.includes("Restore profiles and the starting scene"));
    assert.ok(bubble.textContent.includes("character card and selected opening"));
    for (const button of buttons) assert.ok(document.getElementById(button.getAttribute("aria-describedby")));
    buttons[1].click(); buttons[1].click();
    const requests = h.sent.filter(payload => payload.type === "story_create_setup"); assert.equal(requests.length, 1);
    assert.equal(requests[0].chatId, "chat"); assert.equal(buttons[0].disabled, true); assert.equal(buttons[1].disabled, true);
    showStartup(h, { code: "processing", processing: true, canCreate: false, canImport: false });
    assert.equal(bubble.querySelectorAll("button").length, 2);
    h.backend({ type: "story_setup_result", chatId: "chat", requestId: requests[0].requestId, ok: true, message: "Ready." });
    h.status({ canCreate: false, setupNoticeId: "notice" });
    assert.equal(bubble.querySelectorAll("button").length, 0); assert.equal(h.button("Create From Character Card").hidden, true);
    assert.equal(bubble.querySelector(".sce-inline-setup"), null);
    assert.ok(!bubble.textContent.includes("Restore profiles and the starting scene"));
    showStartup(h); assert.ok(!document.body.textContent.includes("Ready."));
    assert.ok(document.body.textContent.includes("Import a saved starting state or create one from the character card."));
  } finally { h.restore(); }
});

test("canceling import keeps both startup choices available and starts no creation", async () => {
  const h = mountHarness();
  try {
    const bubble = h.message("notice"); showStartup(h);
    let called = false; h.ctx.uploads.pickFile = async () => { called = true; return []; };
    bubble.querySelector("button").click(); assert.equal(called, true);
    assert.ok([...bubble.querySelectorAll("button")].every(button => button.disabled));
    await Promise.resolve();
    assert.ok([...bubble.querySelectorAll("button")].every(button => !button.disabled));
    assert.equal(h.sent.filter(payload => ["story_import_setup", "story_create_setup"].includes(payload.type)).length, 0);
  } finally { h.restore(); }
});

test("inline import shares the drawer picker and ignores files selected after navigation", async () => {
  const h = mountHarness();
  try {
    const bubble = h.message("notice"); showStartup(h);
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
    const bubble = h.message("notice"); h.events.get("CHARACTER_MESSAGE_RENDERED")({ chatId: "chat", messageId: "notice" });
    assert.equal(bubble.querySelectorAll("button").length, 2);
    h.events.get("CHARACTER_MESSAGE_RENDERED")({ chatId: "chat", messageId: "notice" });
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
    const widget = h.widgets.at(-1); assert.equal(widget.root.isConnected, true); assert.ok(widget.root.textContent !== undefined);
    assert.equal(widget.root.querySelector("button").title, "Loading chat continuity…");
    h.status({ text: "WRONG CHAT", config: { showStatusWidget: true } }); assert.ok(!widget.root.querySelector("button").title.includes("WRONG"));
    h.events.get("CHAT_SWITCHED")({ chatId: null }); assert.equal(widget.root.isConnected, false);
    h.events.get("CHAT_SWITCHED")({ chatId: "chat" }); h.status({ code: "specialized", snapshot: null, config: { showStatusWidget: true } });
    assert.equal(h.widgets.at(-1).root.isConnected, false);
    h.status({ code: "setup", snapshot: null, config: { showStatusWidget: false } });
    const count = h.widgets.length; h.events.get("CHAT_SWITCHED")({ chatId: "third" }); assert.equal(h.widgets.length, count);
  } finally { h.restore(); }
});
