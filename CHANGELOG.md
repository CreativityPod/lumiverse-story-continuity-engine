# 1.5.4

- Fix the v1.5.3 compact-schema regression that constrained change-field names but lost enum constraints on their values. Scene/objective statuses and character roles/controllers now have field-specific value choices. Instructions and errors identify valid status values; casing and an unknown scene-status claim normalize conservatively.
- Field-specific repair preserves unaffected changes in the same record, including initial clock/weather while correcting scene status. Compact and legacy full responses share this behavior.
- A world/section failure during initialization no longer leaves an empty drawer when validated profiles are available. A persistent, explicitly incomplete preview shows validated profiles, places and available scene fields; failed world fields are marked unavailable.
- Preview data never becomes a checkpoint, injected story context, variable mirror or exported setup. Private profile facts remain opt-in, source changes invalidate previews, and successful setup retires them.
- Complete cached failed-response excerpts can restore an older setup preview without new model calls. Truncated evidence cannot recreate missing facts; Retry Setup remains explicit.
- Add regressions for the reported scene-status failure, field-only repair, enum constraints/normalization, private profile inspection, restart/reopen recovery, preview isolation, routine-failure visibility and successful retry cleanup.

# 1.5.3

- Tracker responses use compact field changes; unchanged facts inherit locally and new character declarations can omit unsupported profiles. Existing saves, setup exports, canonical schema and legacy full-response handling remain compatible.
- Preserved records restore their saved values before replacement fields are validated. Identity/controller checks remain enforced.
- Reference validation reports all offending aliases, indexed fields and missing declarations together. Targeted repair retains validated records and requires explicit replacements for rejected records; incomplete repairs cannot silently drop relationships.
- Repair preserves actual rejected text/tool arguments. Empty, malformed, wrong-type, reasoning-only, truncated, refused, missing-tool and transport responses receive distinct diagnostics; one shared deadline still covers generation and its single repair.
- Quiet requests clear narrative stop sequences, pin resolved connections, expose effective output mode, and support the selected OpenAI Responses preset format and an explicit Google mode.
- Bounded private response excerpts, attempt metadata and success/repair/failure totals persist outside canonical state. The drawer identifies pending and last tracked turns, explains saved rejection pauses, and clears private evidence on hide/navigation.
- Old contract rejection pauses can retry with the improved protocol without replaying successful checkpoints. Transient provider failures retain their automatic retry behavior; failed initialization retains explicit Retry Setup.
- Added recovery, dependency, atomicity, privacy, protocol-upgrade and provider-payload regressions plus an opt-in local Lumiverse provider smoke suite.

# 1.5.2

- Initial setup reports reading cards/lore, generating, validating, repairing when needed, saving, and readiness in the chat controls and drawer, with locally updated elapsed time.
- Failures retain their stage, stopped time and expandable error details; Create becomes **Retry Setup**. Status checks, navigation, events and settings changes no longer restart failed initialization.
- Interrupted runs and older failures remain inspectable across restarts. Retry uses the current choices/sources; an already valid baseline can finish saving without another profile generation.
- Progress stays outside story messages, canonical state and portable setups. Inline controls still retire after profile readiness, and successful imports recover locally without generation.

# 1.5.1

- New card setups automatically fill entirely missing outfits for model-controlled characters, alongside date, time and weather, in the existing initialization request.
- Preserve partial clothing descriptions and explicit absence of clothing; record inapplicability rather than forcing clothes onto characters that do not wear them. User-controlled outfits remain user-defined.
- **Fill missing scene details** now covers minor grooming, atmosphere and mild mood. Inline and drawer descriptions reflect the automatic outfit default.
- Unknown model-character starting outfits use the existing single repair limit. Saved outfits persist; routine tracking, existing saves and imports do not regenerate them. Canonical state and portable formats remain compatible.

# 1.5.0

- New card setups fill missing fictional date, time and weather during the existing extraction request, respecting established card/opening/lore constraints.
- Optional **Fill missing scene details** starts off and permits missing model-character outfit, minor grooming, mild mood and brief atmosphere. Inline and drawer choices stay synchronized and disappear after setup.
- Saved defaults survive reopen, turn reprocessing, forks and portable export/import. Existing/imported setups are not backfilled; routine tracking and imported-profile refresh cannot generate new scene defaults.
- Setup choice survives worker restarts; missing initial clock/weather uses the existing single repair limit with no new generation stage or canonical schema change.
- Reviewed tests remove redundant provider combinations, obsolete notice mocks and implementation-name checks while retaining behavior coverage and testing the new setup policy/lifecycle.

# 1.4.4

- Setup controls attach directly beneath the narrative opening; no hidden placeholder, progress, error or completion notice is posted. Legacy notices are removed even while awaiting setup.
- Import and Create use matching primary buttons, centered above shorter descriptions. Controls disappear on success while the opening stays intact.
- Chats without an opening retain drawer setup; progress, cancellation, retries, navigation and virtualized opening rendering remain supported.

# 1.4.3

- Startup buttons include short instructions explaining saved setup import and creation from the card/selected opening.
- Successful profile creation or import removes the entire temporary setup message, instructions and controls without posting a hidden completion notice.
- Older ready/interrupted notices are cleaned up without tracker calls or checkpoint changes. Import recovery anchors remain intact; deletion failures retry later and deleted notice IDs stay out of already assembled prompts.

# 1.4.2

- Routine tracker catalogs distinguish editable records from reference-only identities; provider schemas restrict entity records to selected IDs and new creation aliases while keeping character cross-references available.
- Place selection retrieves unique saved sublocations and places named in selected characters' positions, preserving ambiguity and numeric qualifiers.
- Unchanged records labeled `update` retain saved facts/provenance without consuming a repair. Changed out-of-scope records remain rejected, with all offending aliases/names supplied to the single repair.
- Rejected routine turns pause unchanged automatic retries across events and worker restarts. Explicit Reprocess, relevant edits/settings changes or refreshed sources/state allow retry; transient provider errors remain retryable. Existing checkpoints and setup files remain compatible.

# 1.4.1

- Chat widget matches Image Browser's 48 × 48 footprint and 32 × 32 icon size, with a colorful gradient book and gold bookmark.
- The artwork retains its colors while a compact badge indicates setup, processing, readiness or attention. Processing animation stays on the badge and respects reduced motion.
- Full-size click target, hover treatment and keyboard focus accompany the existing drawer shortcut, drag behavior and visibility preference.

# 1.4.0

- New startup message offers Import Saved Setup and Create From Character Card. The engine waits for the user's choice before extraction; canceling import preserves the choices.
- Shared inline/drawer handlers retain direct file-picker activation, prevent duplicate actions and ignore results after navigation. Completed setup retires the inline buttons.
- Import restores the saved setup without an unused initial tracker call. Existing initialized chats resume without another choice; pending choices survive reopens and worker restarts.
- Enabled floating widget appears before the first snapshot, reflects setup/generation/readiness, follows active-chat navigation and remains hidden on Home or specialized-card chats.
- Begin Story uses Lumiverse's supported triggerGeneration append option.
- Canonical schema and portable format remain compatible; optional startup fields extend the existing storage envelope.

# 1.3.0

- First-time initialization posts a single system notice before generating initial character profiles and story state, then updates that message to ready or failed.
- Retries and interrupted initialization reuse the notice. Ordinary updates and loading existing/imported state do not post new generation notices.
- Notices stay outside narrative tracking, source selection, branch fingerprints and roleplay prompts, and are hidden from recall embeddings where supported.
- Notice message events cannot trigger recursive tracker calls. Editing or deleting the notice preserves valid story checkpoints; notice I/O failures do not block tracking.
- Canonical saves, setup formats and Date Simulator routing remain compatible.

# 1.2.0

- Initialization, routine tracking, imported profile refresh and roleplay injection use short typed entity aliases instead of persistent IDs/GUIDs.
- Per-request provider schemas enumerate supplied aliases; plain JSON prompts receive the same identity and creation catalog.
- New characters, places, relationships and objectives use explicit creation placeholders and receive persistent IDs from the backend.
- Strict alias/reference validation prevents unknown IDs from silently creating replacement entities. Rejected output gets one repair; failure retains the last valid checkpoint.
- Canonical saves, imports/exports, chat-variable mirrors and fork identities remain compatible without migration. Date Simulator is unchanged.

# 1.1.0

- Routine tracker calls use extracted profiles and selected current state rather than resending full card sources.
- Local source lookup supplies bounded relevant excerpts for omitted stable facts. Original cards remain saved for initialization, profile refresh, lookup and portable export.
- Main roleplay injection selects the active cast, place and immediate context under a 24,000-character JSON budget. Omitted facts remain canonical and available for later retrieval.
- Scoped output merges preserve absent entities; out-of-scope updates are rejected before commit.
- Tracker schema v2 adds per-character relationship context and boundaries, with stable-field coverage informed by Date Simulator.
- Existing v1 state/setup data upgrades locally. Full v2 and legacy v1 chat-variable mirrors coexist.
- Existing drawer controls and Date Simulator routing remain available.
