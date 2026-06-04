# `lib/hydration`

Startup hydration from daemon snapshots.

## Files

- `hydrate.ts` fetches server capabilities, current workers, current terminals, and initial blocking inbox items.
- `index.ts` re-exports hydration helpers.

## Responsibilities

- Seed local in-memory state from current daemon state after the initial connection succeeds.
- Populate capabilities from the hello handshake.
- Seed inbox items only for current blocking conditions rather than replaying history.

## Key integration points

- `index.ts` calls `hydrate()` before registering steady-state event processing.
- `lib/state/` receives hydrated workers, terminals, and inbox items.
- `lib/chat/` observes hydrated workers so chat watchers can start after hydration.
