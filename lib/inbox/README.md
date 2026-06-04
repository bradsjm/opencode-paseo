# `lib/inbox`

Inbox query and presentation helpers.

## Files

- `inbox.ts` provides filtered inbox reads and summary counts.
- `ids.ts` contains deterministic IDs for special inbox cases such as hydrated permission items.
- `summary.ts` truncates human-facing inbox summaries.
- `index.ts` re-exports the public helpers for this folder.

## Responsibilities

- Keep inbox reading, counting, and summary formatting separate from raw state mutation.
- Provide stable IDs where the plugin needs to correlate hydration-time and live events.

## Key integration points

- `lib/state/inbox-state.ts` owns insertion and read-state mutation.
- `lib/hooks/` and `lib/chat/` create inbox items that rely on these helpers.
- `lib/tools/inbox.ts` exposes the read/status surface to OpenCode.
