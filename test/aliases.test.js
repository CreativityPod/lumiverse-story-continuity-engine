import assert from "node:assert/strict";
import test from "node:test";
import { createAliasRegistry, encodeModelState, encodeModelSources, encodeModelReferences, modelAliasCatalog, aliasOutputSchema, decodeModelOutput } from "../src/aliases.js";
import { trackerStateForLlm, materializeTrackerOutput, validateState } from "../src/schemas.js";
import { buildRoleplayContext } from "../src/context.js";
import { SOURCES, fixtureState, character, modelOutput } from "./fixtures.js";

const GUID = "12345678-1234-4321-8765-123456789abc";
const LORE_GUID = "abcdefgh-1234-4321-8765-123456789abc";
function castState() {
  const state = fixtureState();
  const npc = character(`npc:${GUID}`, "npc"); npc.name = "Mira"; npc.visible.position = "Observatory";
  const user = character("user", "user"); for (const key of Object.keys(user.internal)) user.internal[key] = "Unknown";
  state.characters.push(npc, user);
  state.relationships.push({ id: `rel:${GUID}`, fromId: "char:ada", toId: npc.id, publicStatus: "Colleagues", privateState: "Old debt", boundaryOrConcern: "Unknown", sourceMessageId: "card-baseline" });
  state.objectives.push({ id: `objective:${GUID}`, ownerId: npc.id, objective: "Repair the lens", status: "active", timing: "Tonight", sourceMessageId: "card-baseline" });
  return state;
}

test("all model collections, references and source definitions use typed short aliases", () => {
  const state = castState(), sources = structuredClone(SOURCES);
  sources.cards[0].id = GUID; sources.cards[0].description += ` Reference ${GUID}.`;
  state.characters[0].id = `char:${GUID}`; state.relationships[0].fromId = `char:${GUID}`;
  state.places[0].id = `place:${GUID}`; state.world.immediateContext = `At place:${GUID} with npc:${GUID}.`;
  sources.lore = [{ id: LORE_GUID, content: `Lore for char:${GUID}.` }];
  const before = JSON.stringify({ state, sources }), registry = createAliasRegistry(sources, state);
  const encoded = encodeModelState(trackerStateForLlm(state), registry);
  assert.deepEqual(encoded.characters.map(char => char.id), ["c1", "n1", "u1"]);
  assert.equal(encoded.places[0].id, "p1"); assert.equal(encoded.relationships[0].id, "r1"); assert.equal(encoded.objectives[0].id, "o1");
  assert.equal(encoded.relationships[0].fromId, "c1"); assert.equal(encoded.relationships[0].toId, "n1"); assert.equal(encoded.objectives[0].ownerId, "n1");
  const wire = JSON.stringify({ encoded, sources: encodeModelSources(sources, registry), catalog: modelAliasCatalog(registry), schema: aliasOutputSchema(registry),
    references: encodeModelReferences([{ ownerId: `char:${GUID}`, field: "description", excerpt: `Ask npc:${GUID}.` }, { ownerId: `lore:${LORE_GUID}`, field: "constantLore", excerpt: "The lens is cracked." }], registry) });
  for (const hidden of [GUID, LORE_GUID, "sourceMessageId", "world_book_ids", "char:", "npc:", "place:", "rel:", "objective:", "lore:"]) assert.ok(!wire.includes(hidden), hidden);
  assert.ok(wire.includes('"ownerId":"l1"')); assert.equal(JSON.stringify({ state, sources }), before);
});

test("aliases use the entire saved cast, independent of selected or focused ordering", () => {
  const state = castState(), registry = createAliasRegistry(SOURCES, state);
  const reordered = trackerStateForLlm(state); reordered.characters.reverse();
  assert.deepEqual(encodeModelState(reordered, registry).characters.map(char => char.id), ["u1", "n1", "c1"]);
  const projection = buildRoleplayContext(state, "Ask Mira", { focusCharacterId: `npc:${GUID}`, sources: SOURCES });
  assert.deepEqual(projection.characters.map(char => char.id), ["n1", "u1", "c1"]);
  assert.ok(!JSON.stringify(projection).includes(GUID));
  const added = character("npc:second", "npc"); added.name = "Rae"; state.characters.push(added);
  assert.equal(createAliasRegistry(SOURCES, state).aliasFor("characters", `npc:${GUID}`), "n1");
  assert.equal(createAliasRegistry(SOURCES, state).aliasFor("characters", added.id), "n2");
});

test("existing alias round trips preserve canonical identities and unchanged provenance", () => {
  const state = castState(), before = JSON.stringify(state), registry = createAliasRegistry(SOURCES, state);
  const output = modelOutput(state);
  assert.deepEqual(materializeTrackerOutput(decodeModelOutput(output, registry), state, "a1"), state);
  assert.equal(output.characters[0].id, "c1"); assert.equal(JSON.stringify(state), before);
  output.characters[1].visible.dressAndLayers = "Green jacket";
  const updated = materializeTrackerOutput(decodeModelOutput(output, registry), state, "a1");
  assert.equal(updated.characters[1].id, `npc:${GUID}`); assert.equal(updated.characters[1].sourceMessageId, "a1");
  assert.equal(updated.characters[0].sourceMessageId, "card-baseline");
});

test("creation placeholders receive backend ids with consistent cross references and no stored aliases", () => {
  const previous = fixtureState(), proposed = castState();
  proposed.places.push({ ...proposed.places[0], id: "place:new", name: "Observatory" });
  const output = modelOutput(proposed, { previousState: previous });
  assert.deepEqual(output.characters.map(char => char.id), ["c1", "new_n1", "new_u1"]);
  assert.equal(output.places[1].id, "new_p1"); assert.equal(output.relationships[0].id, "new_r1"); assert.equal(output.objectives[0].id, "new_o1");
  output.characters[1].internal.knowledge = "c1 waits at p1; new_u1 asked about new_p1.";
  let allocated = 0;
  const registry = createAliasRegistry(SOURCES, previous, { allocateId: () => `backend-${++allocated}` });
  const next = materializeTrackerOutput(decodeModelOutput(output, registry), previous, "a1");
  assert.equal(allocated, 4); assert.equal(next.characters[1].id, "npc:backend-1"); assert.equal(next.characters[2].id, "user");
  assert.equal(next.places[1].id, "place:backend-2"); assert.equal(next.relationships[0].id, "rel:backend-3"); assert.equal(next.objectives[0].id, "objective:backend-4");
  assert.equal(next.relationships[0].toId, next.characters[1].id); assert.equal(next.objectives[0].ownerId, next.characters[1].id);
  assert.equal(next.characters[1].internal.knowledge, "Ada waits at Station; Traveler asked about Observatory.");
  assert.ok(!JSON.stringify(next).includes("new_"));
  const nextWire = encodeModelState(trackerStateForLlm(next), createAliasRegistry(SOURCES, next));
  assert.equal(nextWire.characters[1].id, "n1"); assert.equal(nextWire.places[1].id, "p2"); assert.equal(nextWire.relationships[0].toId, "n1");
  validateState(next);
});

test("unknown, canonical, wrong-type and duplicate ids cannot create replacement entities", () => {
  const state = castState(), registry = createAliasRegistry(SOURCES, state);
  for (const id of ["c99", "C1", "char:ada", `npc:${GUID}`, "p1", "new_p1", "new_c1", "new_n999"]) {
    const output = modelOutput(state); output.characters[0].id = id;
    assert.throws(() => decodeModelOutput(output, registry), /unknown|different entity type/);
  }
  const duplicate = modelOutput(state); duplicate.characters.push({ ...duplicate.characters[0], id: " c1 " });
  assert.throws(() => decodeModelOutput(duplicate, registry), /duplicate aliases/);
  const preserve = modelOutput(state, { previousState: fixtureState() }); preserve.characters[1].action = "preserve";
  assert.throws(() => decodeModelOutput(preserve, createAliasRegistry(SOURCES, fixtureState())), /creation alias requires action update/);
});

test("alias role/controller and established alias/name pairings are protected", () => {
  const state = castState(), registry = createAliasRegistry(SOURCES, state);
  for (const [key, value] of [["role", "npc"], ["controller", "user"], ["name", "Mira"]]) {
    const output = modelOutput(state); output.characters[0][key] = value;
    assert.throws(() => decodeModelOutput(output, registry), /role\/controller|alias\/name/);
  }
  const renamed = modelOutput(state); renamed.characters[0].name = "Ada Vale"; renamed.characters[0].internal.knowledge = "c1 found a clue.";
  assert.equal(decodeModelOutput(renamed, registry).characters[0].internal.knowledge, "Ada Vale found a clue.");
  const sources = structuredClone(SOURCES); sources.cards.push({ id: "mira", name: "Mira" });
  const initial = modelOutput(undefined, { initialize: true }); initial.characters[0].name = "Mira";
  assert.throws(() => decodeModelOutput(initial, createAliasRegistry(sources)), /alias\/name/);
});

test("relationships and objectives require exact existing or declared creation character aliases", () => {
  const state = castState(), registry = createAliasRegistry(SOURCES, state);
  for (const id of ["n9", "p1", "new_n1", `npc:${GUID}`]) {
    const rel = modelOutput(state); rel.relationships[0].toId = id;
    assert.throws(() => decodeModelOutput(rel, registry), /unknown or undeclared character alias/);
    const obj = modelOutput(state); obj.objectives[0].ownerId = id;
    assert.throws(() => decodeModelOutput(obj, registry), /unknown or undeclared character alias/);
  }
});

test("repair reuses allocations but cannot reference a creation omitted from the repaired response", () => {
  const previous = fixtureState(), proposed = castState();
  let calls = 0; const registry = createAliasRegistry(SOURCES, previous, { allocateId: () => `allocated-${++calls}` });
  const invalid = modelOutput(proposed, { previousState: previous }); invalid.relationships[0].toId = "new_n2";
  assert.throws(() => decodeModelOutput(invalid, registry), /undeclared/);
  const assigned = calls, valid = modelOutput(proposed, { previousState: previous });
  const repaired = decodeModelOutput(valid, registry); assert.equal(calls, assigned); assert.equal(repaired.characters[1].id, "npc:allocated-1");
  valid.characters = valid.characters.filter(char => !char.id.startsWith("new_"));
  assert.throws(() => decodeModelOutput(valid, registry), /undeclared/);
});

test("dynamic structured-output schemas enumerate only supplied typed aliases", () => {
  const state = castState(), registry = createAliasRegistry(SOURCES, state), schema = aliasOutputSchema(registry);
  const charIds = schema.properties.characters.items.properties.id.enum;
  assert.ok(charIds.includes("c1") && charIds.includes("n1") && charIds.includes("u1") && charIds.includes("new_n1"));
  assert.ok(!charIds.includes("new_u1") && !charIds.includes("p1"));
  assert.deepEqual(schema.properties.relationships.items.properties.fromId.enum, charIds);
  assert.deepEqual(schema.properties.objectives.items.properties.ownerId.enum, charIds);
  assert.ok(schema.properties.places.items.properties.id.enum.includes("p1"));
  assert.equal(schema.properties.characters.maxItems, 24);
  const full = fixtureState(); for (let index = 0; index < 23; index++) full.characters.push(character(`npc:full-${index}`, "npc"));
  assert.deepEqual(modelAliasCatalog(createAliasRegistry(SOURCES, full)).creation.characters, []);
});

test("preserved entities keep their established names when decoding other entities' prose", () => {
  const state = castState(), output = modelOutput(state);
  output.characters[0].action = "preserve"; output.characters[0].name = "Wrong proposed name";
  output.characters[1].internal.knowledge = "c1 asked about p1.";
  const decoded = decodeModelOutput(output, createAliasRegistry(SOURCES, state));
  assert.equal(decoded.characters[1].internal.knowledge, "Ada asked about Station.");
  assert.equal(materializeTrackerOutput(decoded, state, "a1").characters[0].name, "Ada");
});

test("explicit creation keeps distinct same-name characters separate", () => {
  const previous = fixtureState(), proposed = fixtureState(), npc = character("npc:new", "npc");
  npc.name = "Ada"; proposed.characters.push(npc);
  const output = modelOutput(proposed, { previousState: previous });
  const next = materializeTrackerOutput(decodeModelOutput(output, createAliasRegistry(SOURCES, previous, { allocateId: () => "distinct" })), previous, "a1");
  assert.equal(next.characters[0].id, "char:ada"); assert.equal(next.characters[1].id, "npc:distinct"); assert.equal(next.characters[1].role, "npc");
});
