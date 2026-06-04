# `lib/state`

In-memory plugin state and mutation helpers.

## Files

- `types.ts` defines the plugin-owned state model.
- `state.ts` creates, resets, and mutates core state plus session/resource bindings.
- `inbox-state.ts` owns inbox insertion, unread tracking, and blocking metadata helpers.
- `status.ts` maps daemon worker status strings into the plugin's status model.
- `index.ts` re-exports public helpers.

## Responsibilities

- Keep the canonical in-memory model for connection status, sessions, workers, terminals, chat rooms, inbox items, queued launches, and ephemeral runs.
- Centralize session/resource binding rules so tools and hooks do not each invent their own bookkeeping.
- Preserve plugin-owned derived data such as unread counts and blocking metadata.

## Key integration points

- `index.ts`, hydration, daemon hooks, chat watching, worker launch queue, and tools all mutate this shared state.
