import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("spindle.json", root), "utf8"));
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.identifier, "story_continuity_engine");
assert.equal(manifest.name, "Story Continuity Engine");
for (const permission of ["generation", "interceptor", "chat_mutation", "characters", "chats", "world_books", "ui_panels"]) assert.ok(manifest.permissions.includes(permission));
const backend = await readFile(new URL(manifest.entry_backend, root), "utf8");
// Exercise the built entry points rather than pinning internal names or prompt/UI
// wording. Feature behavior belongs in the corresponding unit/integration tests.
let backendHandler;
new Script(backend, { filename: manifest.entry_backend }).runInNewContext({ spindle: {
  permissions: { has: () => false, onChanged() {} },
  onFrontendMessage: handler => { backendHandler = handler; }, on() {},
} });
assert.equal(typeof backendHandler, "function", "Built backend must register its frontend handler");
const frontend = await import(new URL(manifest.entry_frontend, root));
assert.equal(typeof frontend.setup, "function", "Built frontend must export setup");
console.log("Package validation passed.");
