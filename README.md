# Story Continuity Engine

Persistent character and world state for any character card. Version **1.8.3** is a separate Lumiverse Spindle extension with its own **Story Continuity** drawer, backend storage, and `story_continuity.*` chat variables.

## Install

1. Extract `release/Story_Continuity_Engine_v1.8.3.zip` into your Lumiverse `data/extensions` directory. The archive contains the top-level `lumiverse-story-continuity-engine/` folder with `spindle.json` and ready-to-run `dist` entries. Use Lumiverse's local extension discovery/reload workflow for that installation.
2. Grant **generation**, **interceptor**, **chat_mutation**, **characters**, and **chats**. These support quiet tracker calls, prompt injection, chat-variable mirrors, and card/chat reads. Grant **world_books** to include enabled constant entries from attached lorebooks and **ui_panels** for the floating widget. This extension does not modify character cards or lorebooks.
3. Open an ordinary character chat. Choose **Import Saved Setup** or **Create From Character Card** beneath the opening message, or use the matching controls in the **Story Continuity** drawer. A new chat is recommended for the first run.
4. Optionally select a tracker connection and structured-output mode, then select **Save Settings**. Without a selection, the host's default connection is used.

Built entries are included; installation does not require npm or the development dependencies. Core tracking uses the Lumiverse extension APIs. Optional Jev retrieval requires a host exposing the Decision API (`decisions-v1`); it is off by default and falls back to local selection when unavailable. A public repository has not been created or published.

## How it works

1. **Set up the chat.** Choose **Create From Character Card** to build a starting snapshot from the cards, selected opening, and enabled constant lore entries when permitted, or choose **Import Saved Setup** to reuse one. When creating from a card, the engine preserves established details and fills gaps in the starting date, time, weather, and outfits for model-controlled characters. **Fill missing scene details** also allows minor grooming, mood, and atmosphere. Unspecified profile facts such as age and gender stay `Unknown`.
2. **Track the story.** After each eligible assistant turn, a background model call updates character profiles and appearance, outfits and items, relationships, places, objectives, and the fictional clock. The tracker preserves established facts until the story changes them. You retain control of your character’s actions and internal state.
3. **Carry continuity forward.** The engine saves validated changes as a checkpoint and adds relevant saved details to the next roleplay prompt. If a tracker response is partly invalid, the engine can save valid changes and flag unresolved fields in the drawer.

For image generation, use `{{getchatvar::story_continuity.visual_text_v1}}` to supply observable scene details. See the [ImageGen setup guide](IMGGEN.md) and [tracking architecture](ARCHITECTURE.md) for more detail.

### Optional Jev-assisted retrieval

Jev can bring additional saved characters, relationships, places, and objectives into roleplay prompts and tracker updates. It sends saved story state, including private details, and recent turn text to the configured Decision model. It only selects records. Core tracking uses local selection by default and falls back to it when Jev is unavailable.

To enable Jev, use a Lumiverse host with the Decision API (`decisions-v1`), configure a Decision connection, and grant the extension **decisions** permission. In **Tracker settings → Connection settings**, set **Context retrieval** to **Jev-assisted selection**, choose a Decision connection or keep the default, then select **Save Settings**. [Retrieval details](ARCHITECTURE.md#jev-assisted-context-retrieval)

## Drawer and widget

The drawer uses Lumiverse native switches, selects, numeric inputs, checkbox, and badge when available; older hosts get themed HTML controls. Advanced and private sections use persistent details elements so mounted controls survive collapsing.

Deleting a chat automatically removes its tracking profile, including saved state, checkpoints and diagnostics, and clears that chat from the drawer. Removal starts immediately even when tracking is still running; a final cleanup after pending work prevents an already-started storage write from restoring the file. **Clean Unused Tracking Files** can remove older leftovers, including chats deleted while the extension was not running.

- **Tracking enabled**, **Show Widget**, tracker connection, output mode, output budget, timeout, **Save Settings**, and **Refresh Connections**.
- Startup **Import Saved Setup** / **Create From Character Card** choices beneath the opening message, with matching drawer actions and running setup stages/elapsed time. Failure details remain in the drawer; inline controls show the available profile or paused status and offer **Retry Setup**. While a file picker or setup request is pending, both actions are disabled to avoid duplicate choices.
- An observable snapshot of the world, characters/NPCs, public relationships, and recurring places.
- **Fill Missing Age / Gender** extracts only missing age/gender from saved card sources. It leaves known values, scenes, identity prose and other tracking intact. It does not reread newly edited card definitions; use Refresh Card Profiles for a deliberate full refresh.
- **Show Private Tracker State** explicitly reveals full state including profiles, secrets, knowledge, intentions, and objectives.
- **Reprocess Latest Turn** reruns the latest eligible turn against its preceding checkpoint.
- **Retry Incomplete Tracking** corrects unresolved components in the earliest partial checkpoint, preserving its accepted values before replaying later turns as needed.
- **Refresh Card Profiles** rebuilds a native baseline from the edited card and reconciles selected history. For an imported setup, it fills missing stable profile fields from that setup's saved sources while preserving its recorded scene and existing facts. Card edits are flagged before this action; opening edits/swipes rebuild native baselines automatically.
- **Clean Unused Tracking Files** scans only this extension's files, requires a second click to delete, and verifies candidates again. Malformed or unprovable files are retained.
- When **Show Widget** is enabled, the draggable, edge-snapping floating icon appears in an eligible chat as soon as its settings are available, including before a snapshot exists. It opens the drawer and reflects waiting for setup, generation, readiness or attention. It follows chat navigation, disappears on Home, respects reduced-motion preferences, and defers specialized cards to Date Simulator. Missing UI panels permission does not prevent tracking.
- The widget matches Image Browser's **48 × 48** footprint and **32 × 32** artwork. A purple/indigo/cyan book with a gold bookmark stays colorful in every state; its small indicator is amber for setup, cyan while processing, green when ready and rose with an exclamation mark for attention. Keyboard focus remains visible and reduced-motion settings disable the indicator pulse and hover transition.

“Private” means omitted from ordinary replies and the default snapshot. The model receives private state, the user can inspect it, and Lumiverse's prompt inspection can show the injected block. It is not encryption. The tracker is instructed to classify private facts correctly, but extraction accuracy still depends on the selected model.

## Original setup import/export

**Export Initial Setup** saves the original first eligible opening checkpoint, even after later play or reprocessing. It includes card sources and complete private initial state, with portable provenance. It does not include later checkpoints, chat IDs, or transcript history.

The secure-browser Save As API is used when available. Otherwise, **Download JSON File** appears. Canceling Save As writes nothing. Switching chats invalidates a pending export.

**Import Saved Setup** in the startup controls and **Import Setup — Choose File** in the drawer use the same picker and accept this extension's JSON format in a fresh generic chat with no user turns or generation in progress. No unused extraction call is needed before importing. An already-created greeting baseline does not prevent a later import while the chat is still fresh. Import validates the file before appending one neutral confirmation with private metadata. The metadata anchor can restore state after sidecar loss or a fork. **Begin Story** generates an observable opening through the host's normal generation API without a tracker call or fictional-clock advance. Editing, swiping away, or deleting the import anchor deactivates its state. Use a matching card for a reusable setup so its voice remains consistent.

## Compatibility and limits

- Date Simulator v1.4/v1.5 and Storyteller v1.6 cards/anchors are deferred to **Date Simulator Continuity Engine**, preventing overlapping generic injection. Their existing extension is unchanged. Its setup files are not accepted here.
- Initialization reads enabled **constant** lore entries attached to the cards when permitted. Conditional lore remains governed by Lumiverse activation; this release learns resulting facts from completed narrative rather than copying every conditional entry into state.
- State supports up to 24 characters total, 48 relationships, 32 places, and 12 objectives. Text fields allow 1,600 characters; total canonical state is capped at 64,000 characters. Original card/lore sources are capped at 96,000 characters. These are ceilings, not target lengths.
- Original-source retrieval uses local keywords and topic matching, capped at eight excerpts and 6,000 serialized characters per update. Long passages are marked partial. Matching is conservative and may miss a relevant detail; it does not make an extra LLM call to search. Use **Refresh Card Profiles** for deliberate re-extraction when needed.
- Schema 3 is the minimum supported story state. The engine resumes v1.8.2 checkpoints and imports its initial setup files directly. Stable participant data includes identity, disposition, preferences, relationship context, and boundaries. The starting scene is saved in the world and character baseline. **Fill Missing Age / Gender** can backfill unknown values from saved sources.
- `story_continuity.state_v3` contains the full state. Use `story_continuity.public_v2` for observable JSON with age and gender, or `story_continuity.visual_text_v1` for ImageGen text. Update presets that read the retired `state_v1`, `state_v2`, or `public_v1` keys. The engine removes those variables when it checks a chat, including an imported chat when it is opened. Lumiverse hosts with chat variable history cleanup also remove the keys from saved swipe snapshots.
- Tracker output supports 400–32,768 tokens (default 16,384). Timeout supports 5–300 seconds (default 300). Existing saved settings retain their chosen values; change them in the drawer and select **Save Settings** to use the new defaults in an existing installation. Original output and its one repair share a deadline, capped by the remaining 300-second reconciliation budget. Large existing chats can require another reprocess pass after that budget; completed checkpoints are retained.
- **Auto**, **OpenAI-compatible JSON Schema**, **OpenAI Responses JSON Schema**, **Anthropic Tool**, **Google JSON Schema**, and **Plain JSON (prompt only)** are selectable. Auto selects a structured mode for recognized providers; other providers use prompt-only JSON. Quiet tracker requests clear narrative stop sequences and pin a resolved default connection. OpenAI mode uses Responses formatting when the selected preset requests it and is readable, otherwise Chat Completions formatting. Explicit Responses mode works without the additional host Presets permission. The drawer records the effective mode. Schemas enumerate entity aliases and permitted field paths; strict local validation owns cross-record dependencies, field bounds, role protection and provenance.
- The engine records continuity. It does not autonomously simulate off-screen actions, forecast real weather, invent missing history, or replace the host's character definition.

## Development and validation

```sh
npm ci
npm run check
npm run package
```

`npm run check` builds both entries, runs schema/alias/state/context/tracker/backend/DOM tests, and validates the package. Tests cover message-free setup choices, initialization stages/timing and explicit retries, legacy notice cleanup/filtering, GUID-free context, identity allocation and repair, cross-references, provider formats, routine context selection/budgets, retired variable cleanup, v3 saves, privacy/user control, branch edits and stale results, forks, import recovery, frozen exports, navigation, cleanup confirmation, and native/fallback drawer controls. Package validation starts the built backend and verifies the frontend's `setup` export.

`npm run smoke` explains the opt-in live provider suite without making requests. To run it, set `LUMIVERSE_URL` to your local server, `STORY_SMOKE_CONNECTION` to an existing connection ID, and `LUMIVERSE_COOKIE` if your server requires session authentication; then use `npm run smoke -- --live`. Optional `STORY_SMOKE_OUTPUT_MODE` overrides Auto. The suite exercises initial extraction, clothing changes and a new NPC through Lumiverse's real quiet-generation endpoint, using synthetic fixtures and up to six generations. It creates no chats or saved story state and prints only outcome/usage/timing metadata. Live results are separate from deterministic unit-test coverage.

For a standalone visual preview, serve this directory locally and open `test/browser-preview.html`. It uses the actual frontend with fixture data and simulated setup transitions, including an import-picker cancellation. It does not access Lumiverse or make model calls. Startup controls, the pre-generation widget and the drawer have been inspected in dark and light themes. Live provider behavior and an installed Lumiverse session still require an integration run.
