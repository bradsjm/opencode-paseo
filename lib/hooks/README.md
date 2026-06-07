# `lib/hooks`

Daemon-event mapping for the plugin.

## Files

- `daemon-events.ts` syncs compact upstream-shaped transport events into state, derived inbox entries, read-state changes, and OpenCode nudges.

## Responsibilities

- Keep daemon event interpretation centralized.
- Preserve upstream agent status while projecting snapshots into the plugin's worker summary model.
- Decide which daemon events create inbox items and which ones only update state.

## Key integration points

- `lib/hooks.ts` re-exports the daemon event handler factory and owns OpenCode hook entrypoints.
- `lib/state/` owns the resulting in-memory state mutations.
- `lib/notifier.ts` owns nudge formatting and delivery; hook logic gates nudges by config and background ownership.

## Notes

- `agent_stream` is currently state-silent here.
- Permission resolution marks matching unread permission inbox items as read.
