# `lib/chat`

Chat-specific helpers for worker coordination.

## Files

- `worker-room.ts` normalizes chat room names, reads the reserved `opencodePaseo.chatRoom` worker label, and appends coordination instructions to worker prompts.
- `watch.ts` watches known worker chat rooms, advances per-room cursors, and inserts `chat.mentioned` inbox events when known workers are mentioned.

## Responsibilities

- Keep chat-room naming and reserved label handling in one place.
- Treat chat watchers as best-effort background observers rather than durable state.
- Route chat mentions into the shared inbox/nudge pipeline instead of inventing a parallel notification path.

## Key integration points

- `index.ts` creates the chat watcher and calls `observeWorker()` for hydrated and newly observed workers.
- `lib/tools/chat.ts` exposes direct chat-room tools.
- `lib/state/` stores watched room cursors and watch status.

## Notes

- Mention-based nudges only fire for known workers and only when the message author is not the same worker.
- The watcher seeds its cursor from the latest known message, so it is designed to avoid replaying old room history.
