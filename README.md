# Story Continuity Engine

Persistent character and world state for any character card. Version **1.4.1** is a separate Lumiverse Spindle extension with its own **Story Continuity** drawer, backend storage, and `story_continuity.*` chat variables.

## Install

1. Extract `release/Story_Continuity_Engine_v1.4.1.zip` into your Lumiverse `data/extensions` directory. The archive contains the top-level `lumiverse-story-continuity-engine/` folder with `spindle.json` and ready-to-run `dist` entries. Use Lumiverse's local extension discovery/reload workflow for that installation.
2. Grant **generation**, **interceptor**, **chat_mutation**, **characters**, and **chats**. These support quiet tracker calls, prompt injection, chat-variable mirrors, and card/chat reads. Grant **world_books** to include enabled constant entries from attached lorebooks and **ui_panels** for the floating widget. This extension does not modify character cards or lorebooks.
3. Open an ordinary character chat. Choose **Import Saved Setup** or **Create From Character Card** in the startup message, or use the matching controls in the **Story Continuity** drawer. A new chat is recommended for the first run.
4. Optionally select a tracker connection and structured-output mode, then select **Save Settings**. Without a selection, the host's default connection is used.

Built entries are included; installation does not require npm or the development dependencies. The implementation targets the local Lumiverse 1.1.6 APIs. A public repository has not been created or published.

## How it works

The engine reads each card in the chat or group: name, description, personality, scenario, example dialogue, creator notes, and the actual selected opening. The selected opening takes priority over the default greeting. Unselected alternate greetings and system/post-history instructions are not turned into story facts. Example dialogue and creator notes are guidance, not completed history.

A quiet LLM call extracts a structured baseline. Complete bounded card source text is saved alongside the extracted state. The original card remains the host's characterization source. The engine separates stable profiles and appearance from current visible and internal state, keeps recurring identities persistent, and leaves missing facts as `Unknown`.

An uninitialized chat first displays a **Story Continuity Engine** system message asking how to initialize the story, with two buttons: **Import Saved Setup** and **Create From Character Card**. The engine waits for this choice before making an extraction call. Import opens the JSON picker and restores existing profiles/state locally; canceling leaves both choices available. Create extracts new profiles and starting state from the card and selected greeting. The drawer offers the same actions if the opening message is scrolled out of view or inline controls are unavailable. Import remains limited to chats with no user turns and no already-loaded setup; an uninitialized chat with existing user turns can still choose Create to track its history.

After choosing Create, the same message says “Generating the initial character profiles and starting story state… Please wait.” It updates to “Initial profiles and story state are ready.” on success, including successful import, or a generic failure notice directing you to the drawer. Inline choices retire once state is ready. It never displays profiles, secrets or raw error details. Retries reuse the notice, and ordinary turn updates do not post additional messages. Previously initialized chats resume without a new choice or extraction solely from upgrading. Waiting for setup persists across reopens and worker restarts; sending a normal turn does not silently choose creation.

The notice stays visible to the user but is excluded from story tracking, branch fingerprints and outgoing roleplay prompts. The engine also sets Lumiverse's hidden-from-recall flag where supported to exclude the row from memory embeddings; that flag alone does not remove linear prompt history, so the interceptor filters it separately. Deleting the notice does not invalidate saved continuity or make the engine repost it during routine updates. Notice write errors do not prevent tracking.

After each eligible completed assistant turn, the engine supplies the extracted stable profiles inside the relevant previous state, a compact identity catalog, and that interaction to the tracker. Original cards are sent in full during initialization and explicit profile refresh. Routine updates consult the frozen sources locally and include only relevant reference excerpts for facts missing from the extracted profiles. Guidance, example dialogue and the original opening are excluded from factual lookup excerpts. Current story changes take precedence over starting conditions.

Relevance selection retains the focused main character, user character, mentioned or colocated characters, current/mentioned places, relationships between selected characters, and immediate objectives. Scoped tracker results merge into complete canonical storage; omitted entities persist and cannot be overwritten by an out-of-scope update. The backend validates the result and branch fingerprint before committing a checkpoint. Routine rechecks do not make model calls or change revision timestamps.

All extension-generated model context uses short entity aliases: `c1` for a card character, `n1` for an NPC, `u1` for the user, `p1` for a place, `r1` for a relationship, `o1` for an objective, and `l1` for a source lore entry. Names accompany character/place aliases. The backend maps these aliases to the original persistent IDs; the model never has to copy GUIDs. The same mapping is derived from the full saved cast for each request, even when only selected entities are sent. Use names in story prose; aliases are internal bookkeeping.

New entities use supplied creation placeholders such as `new_n1` or `new_p1`. The backend assigns their persistent IDs and resolves their relationship/objective references. Unknown, mistyped, duplicate, or incorrectly typed aliases and undeclared creation references reject the whole result and receive one repair attempt. A failed repair retains the last valid checkpoint. Aliases reduce copying errors but cannot guarantee that a model associates every valid alias with the correct facts. Canonical saves, chat-variable mirrors, setup exports, imports, and forks retain persistent IDs and require no migration for this release.

Before the next roleplay prompt, the engine injects a selected private snapshot capped at **24,000 JSON characters**. Whole field values are admitted or omitted, never shortened in storage. The projection reports omitted records/fields, and its instructions explain that omission does not erase established facts. This bounds the extension's JSON contribution; Lumiverse still supplies the normal character card, history, and other prompt sections separately.

| State | Fields |
|---|---|
| World | Fictional date/time, weather, location, immediate context, proximity/contact, scene lifecycle |
| Every main character / NPC | Persistent ID, name, controller, stable profile and appearance, current visible state, private internal state |
| Stable profile | Identity, background, personality/disposition and voice, preferences/deal-breakers, relationship history/agreements, boundaries, private facts/secrets and durable health/capability constraints |
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
- Startup **Import Saved Setup** / **Create From Character Card** choices in the opening system message, with matching drawer actions. While a file picker or setup request is pending, both actions are disabled to avoid duplicate choices.
- An observable snapshot of the world, characters/NPCs, public relationships, and recurring places.
- **Show Private Tracker State** explicitly reveals full state including profiles, secrets, knowledge, intentions, and objectives.
- **Reprocess Latest Turn** reruns the latest eligible turn against its preceding checkpoint.
- **Refresh Card Profiles** rebuilds a native baseline from the edited card and reconciles selected history. For an imported setup, it fills missing stable profile fields from that setup's saved sources while preserving its recorded scene and existing facts. Card edits are flagged before this action; opening edits/swipes rebuild native baselines automatically.
- **Clean Unused Tracking Files** scans only this extension's files, requires a second click to delete, and verifies candidates again. Malformed or unprovable files are retained.
- When **Show Widget** is enabled, the draggable, edge-snapping floating icon appears in an eligible chat as soon as its settings are available, including before a snapshot exists. It opens the drawer and reflects waiting for setup, generation, readiness or attention. It follows chat navigation, disappears on Home, respects reduced-motion preferences, and defers specialized cards to Date Simulator. Missing UI panels permission does not prevent tracking.
- The widget matches Image Browser's **48 × 48** footprint and **32 × 32** artwork. A purple/indigo/cyan book with a gold bookmark stays colorful in every state; its small indicator is amber for setup, cyan while processing, green when ready and rose with an exclamation mark for attention. Keyboard focus remains visible and reduced-motion settings disable the indicator pulse and hover transition.

“Private” means omitted from ordinary replies and the default snapshot. The model receives private state, the user can inspect it, and Lumiverse's prompt inspection can show the injected block. It is not encryption. The tracker is instructed to classify private facts correctly, but extraction accuracy still depends on the selected model.

## Original setup import/export

**Export Initial Setup** saves the original first eligible opening checkpoint, even after later play or reprocessing. It includes card sources and complete private initial state, with portable provenance. It does not include later checkpoints, chat IDs, or transcript history.

The secure-browser Save As API is used when available. Otherwise, **Download JSON File** appears. Canceling Save As writes nothing. Switching chats invalidates a pending export.

**Import Saved Setup** in the startup message and **Import Setup — Choose File** in the drawer use the same picker and accept this extension's JSON format in a fresh generic chat with no user turns or generation in progress. No unused extraction call is needed before importing. An already-created greeting baseline does not prevent a later import while the chat is still fresh. Import validates the file before appending one neutral confirmation with private metadata. The metadata anchor can restore state after sidecar loss or a fork. **Begin Story** generates an observable opening through the host's normal generation API without a tracker call or fictional-clock advance. Editing, swiping away, or deleting the import anchor deactivates its state. Use a matching card for a reusable setup so its voice remains consistent.

## Compatibility and limits

- Date Simulator v1.4/v1.5 and Storyteller v1.6 cards/anchors are deferred to **Date Simulator Continuity Engine**, preventing overlapping generic injection. Their existing extension is unchanged. Its setup files are not accepted here.
- Initialization reads enabled **constant** lore entries attached to the cards when permitted. Conditional lore remains governed by Lumiverse activation; this release learns resulting facts from completed narrative rather than copying every conditional entry into state.
- State supports up to 24 characters total, 48 relationships, 32 places, and 12 objectives. Text fields allow 1,600 characters; total canonical state is capped at 64,000 characters. Original card/lore sources are capped at 96,000 characters. These are ceilings, not target lengths.
- Original-source retrieval uses local keywords and topic matching, capped at eight excerpts and 6,000 serialized characters per update. Long passages are marked partial. Matching is conservative and may miss a relevant detail; it does not make an extra LLM call to search. Use **Refresh Card Profiles** for deliberate re-extraction when needed.
- Tracker schema v2 adds explicit `profile.relationshipContext` and `profile.boundaries`, using Date Simulator's stable-profile coverage as a reference. Participant identity/disposition/preferences/relationship/boundary facts are generic per-character fields; initial context stays in the world/character baseline. Date Simulator is not a runtime dependency.
- Saved schema-v1 state and portable setups upgrade locally without generating history or changing provenance. The new fields initialize as `Unknown` when absent; **Refresh Card Profiles** can re-extract them from sources. The complete mirror is `story_continuity.state_v2`; `story_continuity.state_v1` remains a compatibility projection without the two new profile fields. `story_continuity.public_v1` remains observable-only.
- Tracker output supports 400–16,384 tokens (default 6,144). Timeout supports 5–300 seconds (default 120). Original output and its one repair share a deadline; reconciliation has a 240-second budget. Large existing chats can require another reprocess pass after that budget; completed checkpoints are retained.
- **Auto**, **OpenAI-compatible JSON Schema**, **Anthropic Tool**, and **Plain JSON** are selectable. Auto also supplies Gemini structured JSON when detected. Per-request provider schemas enumerate the available aliases and remain regex-free; strict local validation owns alias resolution, field bounds, role protection, references, and provenance.
- The engine records continuity. It does not autonomously simulate off-screen actions, forecast real weather, invent missing history, or replace the host's character definition.

## Development and validation

```sh
npm ci
npm run check
npm run package
```

`npm run check` builds both entries, runs schema/alias/state/context/tracker/backend/DOM tests, and validates the package. Tests cover initialization notices and event-loop suppression, failed initialization/retry, prompt exclusion, notice deletion and restart recovery, GUID-free model context, identity round trips, backend ID allocation, alias typos and repair, cross-reference validation, all provider modes, routine payload reduction, targeted lookup, relevance selection and budgets, omitted-entity preservation, v1 migration, malformed output, privacy projection, user control, edits/swipes, stale results, forks, metadata import recovery, frozen exports, Home navigation, cleanup confirmation, and native/fallback drawer controls.

For a standalone visual preview, serve this directory locally and open `test/browser-preview.html`. It uses the actual frontend with fixture data and simulated setup transitions, including an import-picker cancellation. It does not access Lumiverse or make model calls. Startup controls, the pre-generation widget and the drawer have been inspected in dark and light themes. Live provider behavior and an installed Lumiverse session still require an integration run.
