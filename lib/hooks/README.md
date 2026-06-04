# `lib/hooks`

Daemon-event mapping for the plugin.

## Files

- `daemon-events.ts` translates transport events into state updates, inbox entries, read-state changes, and OpenCode nudges.

## Responsibilities

- Keep daemon event interpretation centralized.
- Merge partial daemon worker payloads into the plugin's worker summary model.
- Decide which daemon events create inbox items and which ones only update state.

## Key integration points

- `lib/hooks.ts` re-exports the daemon event handler factory and owns OpenCode hook entrypoints.
- `lib/state/` owns the resulting in-memory state mutations.
- `lib/notifier.ts` owns nudge policy and formatting.

## Notes

- `worker.activity` is currently state-silent here.
- Permission resolution marks matching unread permission inbox items as read.
