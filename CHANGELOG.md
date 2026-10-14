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
