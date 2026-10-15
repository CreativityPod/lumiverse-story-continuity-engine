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
