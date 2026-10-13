# Story Continuity Engine

Persistent character and world state for any character card. Version **1.0.0** is a separate Lumiverse Spindle extension with its own **Story Continuity** drawer, backend storage, and `story_continuity.*` chat variables.

## Install

1. Extract `release/Story_Continuity_Engine_v1.0.0.zip` into your Lumiverse `data/extensions` directory. The archive contains the top-level `lumiverse-story-continuity-engine/` folder with `spindle.json` and ready-to-run `dist` entries. Use Lumiverse's local extension discovery/reload workflow for that installation.
2. Grant **generation**, **interceptor**, **chat_mutation**, **characters**, and **chats**. These support quiet tracker calls, prompt injection, chat-variable mirrors, and card/chat reads. Grant **world_books** to include enabled constant entries from attached lorebooks and **ui_panels** for the floating widget. This extension does not modify character cards or lorebooks.
3. Open an ordinary character chat, then open **Story Continuity** in the Spindle drawer. Initialization is automatic. A new chat is recommended for the first run.
4. Optionally select a tracker connection and structured-output mode, then select **Save Settings**. Without a selection, the host's default connection is used.

Built entries are included; installation does not require npm or the development dependencies. The implementation targets the local Lumiverse 1.1.6 APIs. A public repository has not been created or published.

## How it works

The engine reads each card in the chat or group: name, description, personality, scenario, example dialogue, creator notes, and the actual selected opening. The selected opening takes priority over the default greeting. Unselected alternate greetings and system/post-history instructions are not turned into story facts. Example dialogue and creator notes are guidance, not completed history.

A quiet LLM call extracts a structured baseline. Complete bounded card source text is saved alongside the extracted state. The original card remains the host's characterization source. The engine separates stable profiles and appearance from current visible and internal state, keeps recurring identities persistent, and leaves missing facts as `Unknown`.

After each eligible completed assistant turn, the engine supplies the saved sources, previous state, and that interaction to the tracker. The backend validates the result and branch fingerprint before committing a checkpoint. It waits for reconciliation before the next roleplay prompt and injects a compact private projection of the last valid state. Routine rechecks do not make model calls or change revision timestamps.

| State | Fields |
|---|---|
| World | Fictional date/time, weather, location, immediate context, proximity/contact, scene lifecycle |
| Every main character / NPC | Persistent ID, name, controller, stable profile and appearance, current visible state, private internal state |
| Stable profile | Identity, background, personality, preferences, private facts/secrets |
| Stable appearance | Face, eyes, skin, body, distinguishing features |
| Visible state | Hair/grooming, clothing/layers, physical condition, position, current activity, items |
| Internal state | Mood, immediate intent, knowledge, beliefs, concerns |
| Relationships | Two character identities, public status, private state, boundaries/concerns |
| Recurring places | Description, current physical state, connections, private facts |
| Objectives | Character owner, objective, active/completed/abandoned status, timing |

The user retains control over voluntary actions and internal state. User internal fields are normalized by rejection to `Unknown`; a result that invents them cannot be committed. NPCs and places persist when absent from a later output. Time follows narrated events; real waiting time and generation latency do not advance the fictional clock. `/look`, `/scene`, `/debrief`, and the imported setup's beginning recap do not produce tracker updates.

## Drawer and widget

The drawer uses Lumiverse native switches, selects, numeric inputs, checkbox, and badge when available; older hosts get themed HTML controls. Advanced and private sections use persistent details elements so mounted controls survive collapsing.

- **Tracking enabled**, **Show Widget**, tracker connection, output mode, output budget, timeout, **Save Settings**, and **Refresh Connections**.
- An observable snapshot of the world, characters/NPCs, public relationships, and recurring places.
- **Show Private Tracker State** explicitly reveals full state including profiles, secrets, knowledge, intentions, and objectives.
- **Reprocess Latest Turn** reruns the latest eligible turn against its preceding checkpoint.
- **Refresh Card Profiles** rebuilds the baseline from the edited card and reconciles selected history. Card edits are flagged before this action; opening edits/swipes rebuild their baseline automatically.
- **Clean Unused Tracking Files** scans only this extension's files, requires a second click to delete, and verifies candidates again. Malformed or unprovable files are retained.
- A draggable, edge-snapping floating icon opens the drawer, shows updating/attention states, and respects reduced-motion preferences. Missing UI panels permission does not prevent tracking.

“Private” means omitted from ordinary replies and the default snapshot. The model receives private state, the user can inspect it, and Lumiverse's prompt inspection can show the injected block. It is not encryption. The tracker is instructed to classify private facts correctly, but extraction accuracy still depends on the selected model.

## Original setup import/export

**Export Initial Setup** saves the original first eligible opening checkpoint, even after later play or reprocessing. It includes card sources and complete private initial state, with portable provenance. It does not include later checkpoints, chat IDs, or transcript history.

The secure-browser Save As API is used when available. Otherwise, **Download JSON File** appears. Canceling Save As writes nothing. Switching chats invalidates a pending export.

**Import Setup — Choose File** accepts this extension's JSON format in a fresh generic chat with no user turns or generation in progress. A greeting that was already initialized does not prevent import. Import validates the file before appending one neutral confirmation with private metadata. The metadata anchor can restore state after sidecar loss or a fork. **Begin Story** generates an observable opening without a tracker call or fictional-clock advance. Editing, swiping away, or deleting the import anchor deactivates its state. Use a matching card for a reusable setup so its voice remains consistent.

## Compatibility and limits

- Date Simulator v1.4/v1.5 and Storyteller v1.6 cards/anchors are deferred to **Date Simulator Continuity Engine**, preventing overlapping generic injection. Their existing extension is unchanged. Its setup files are not accepted here.
- Initialization reads enabled **constant** lore entries attached to the cards when permitted. Conditional lore remains governed by Lumiverse activation; this release learns resulting facts from completed narrative rather than copying every conditional entry into state.
- State supports up to 24 characters total, 48 relationships, 32 places, and 12 objectives. Text fields allow 1,600 characters; total canonical state is capped at 64,000 characters. Original card/lore sources are capped at 96,000 characters. These are ceilings, not target lengths.
- Tracker output supports 400–16,384 tokens (default 6,144). Timeout supports 5–300 seconds (default 120). Original output and its one repair share a deadline; reconciliation has a 240-second budget. Large existing chats can require another reprocess pass after that budget; completed checkpoints are retained.
- **Auto**, **OpenAI-compatible JSON Schema**, **Anthropic Tool**, and **Plain JSON** are selectable. Auto also supplies Gemini structured JSON when detected. Provider schemas are structural and regex-free; strict local validation owns field bounds, role protection, references, and provenance.
- The engine records continuity. It does not autonomously simulate off-screen actions, forecast real weather, invent missing history, or replace the host's character definition.

## Development and validation

```sh
npm ci
npm run check
npm run package
```

`npm run check` builds both entries, runs schema/state/tracker/backend/DOM tests, and validates the package. Tests cover malformed output and repair, privacy projection, user control, edits/swipes, stale results, forks, metadata import recovery, frozen exports, Home navigation, cleanup confirmation, and native/fallback drawer controls.

For a standalone visual preview, serve this directory locally and open `test/browser-preview.html`. It uses the actual frontend with fixture data and does not access Lumiverse or make model calls. The drawer has been inspected in dark and light themes. Live provider behavior and an installed Lumiverse session still require an integration run.
