# Architecture

`schemas.js` defines the provider action schema and canonical state, strict local validation, backend-owned provenance, public and compact private projections, and source remapping. `state.js` reads bounded source data, recognizes specialized cards, fingerprints selected message prefixes, finds eligible turns, validates portable setups and import anchors, and constructs prompt injection. `tracker.js` performs provider-aware quiet generation with a shared deadline and one repair. `backend.js` owns storage, per-chat queues, event reconciliation, import/export, fork inheritance, scoped frontend status, variable mirrors, and conservative cleanup. `frontend.js` owns the Spindle drawer and widget.

The implementation uses the existing Date Simulator engine's architecture and host API patterns, with an independent generic schema and lifecycle. No runtime imports reach into that extension, and its source files remain unchanged.

## Initialization and source changes

A card-read pass loads chat membership, card definitions, the selected opening, and permitted attached constant lore. Cards use `char:<host-card-id>`, recurring NPCs use `npc:<id>`, the user uses `user`, and places use `place:<id>`. Raw sources and their fingerprint are stored separately from the extracted baseline. Every card must have a corresponding main-character entity. Unknown fields stay unknown. Card changes are surfaced for an explicit profile refresh; selected-opening changes automatically invalidate the baseline because that scene seed is no longer canonical.

The ordinary greeting is initialized once, then receives a checkpoint without being processed as a second event. Later selected assistant turns each receive one replacement-state update. Model outputs cannot supply canonical message IDs: `preserve` copies prior data and provenance; `update` receives the current assistant ID in backend code. Exact unchanged entities retain their previous sources even if the provider labels them updated. Omitted entities remain persistent. Controller roles cannot change, and user internal fields must stay unknown.

## Transactions and branches

Each chat has an independent serialized queue and storage file under the extension's `chats/`. Safe filenames combine a normalized chat token with a fingerprint, avoiding collisions from normalization alone. A checkpoint records its selected assistant ID/swipe, complete prefix fingerprint, validated state, and commit time.

Reconciliation reuses only a contiguous checkpoint prefix. Edits, swipes, deletion, or invalid provenance cut reuse at the first unproven turn. The current state is reset to that prefix before another generation runs, so failed output cannot resurrect a discarded tail. Every generated result is checked against a reread of the selected transcript before commit. Initialization additionally rereads card/opening sources. Revision and revision timestamp change together only when a new baseline/checkpoint commits.

Fork inheritance reconstructs the copied source prefix from Lumiverse's `messageIdMap`, accepts only matching checkpoints, remaps all source IDs and checkpoint keys to the branch, and excludes later source turns. Missing or invalid maps trigger ordinary reconstruction instead of guessing. Imported baseline sources and frozen initial state are remapped too. A confirmed chat deletion queues exact-path sidecar removal after pending work, and a tombstone prevents later writes from recreating it.

## Setups and authority

Portable format 1 is `{format:"story-continuity-initial-setup",version:1,sources,initialState}`. Every exported source ID uses `initial-setup`. File size, field shape, source card identities, canonical state, and source references are validated before import. The assistant anchor's neutral content, active swipe, and `metadata.story_continuity_setup` establish authority; its metadata is included in branch fingerprints. A valid import restores locally without tracker generation. Removing that anchor resets the imported epoch. Begin uses append-and-generate outside the continuity queue and is observation-only.

## Privacy, failure, and budgets

Canonical state and the private `story_continuity.state_v1` mirror remain complete. The `story_continuity.public_v1` mirror and default drawer omit profiles, private facts, internal state, private relationships, boundaries, objectives, and source IDs. Opt-in private inspection returns canonical state. Private facts are still supplied to the roleplay model with explicit knowledge and output boundaries. These boundaries are model guidance, not an encryption or access-control mechanism against the owner.

Structured output is checked for exact keys, leaf types, enums, bounds, duplicate identities, dangling references, unsafe managed markup, user-role changes, and provenance. Invalid output receives at most one repair; failure retains the proven prior checkpoint and reports attention. Quiet original and repair requests share a timeout, and each reconciliation has a bounded overall budget. Long catch-up can resume from completed checkpoints.

Home navigation is explicit. Background events update their originating chat but cannot change the selected frontend route; late status/setup replies are ignored after navigation. Private display and prepared downloads are cleared on chat changes. Setup picker and native Save As calls begin inside user clicks. Cleanup confirmation is scoped to the requesting user and expires; candidates are rechecked inside their chat queue before deletion.
