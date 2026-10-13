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
  const events = new Map(), sent = [], destroyed = [], mounts = [];
  let backend, activate;
  const tab = { root: document.querySelector("main"), destroy() {}, setBadge() {}, activate() {}, onActivate: handler => { activate = handler; return () => {}; } };
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
  const ctx = { components, ui: { registerDrawerTab: options => { assert.equal(options.shortName, "Story Continuity"); return tab; } },
    dom: { addStyle: css => { const style = document.createElement("style"); style.textContent = css; document.head.append(style); return () => style.remove(); }, cleanup() {} },
    sendToBackend: payload => sent.push(payload), onBackendMessage: handler => { backend = handler; return () => {}; },
    events: { on: (name, handler) => { events.set(name, handler); return () => {}; } }, getActiveChat: () => ({ chatId: "chat" }), ready() {}, uploads: { pickFile: async () => [] } };
  const destroy = setup(ctx);
  const status = overrides => backend({ type: "story_status", chatId: "chat", config: { enabled: true, showStatusWidget: false, connectionId: "", outputMode: "auto", maxTokens: 6144, timeoutMs: 120000 },
    code: "active", level: "green", text: "Story continuity is current.", revision: 2, lastRevisionAt: "2026-10-13T16:00:00Z", snapshot: publicTrackerSnapshot(fixtureState()), canImport: true, canExport: true, canBegin: false, ...overrides });
  const button = label => [...document.querySelectorAll("button")].find(button => button.textContent === label);
  return { dom, sent, status, backend: payload => backend(payload), events, button, mounts, destroyed,
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
