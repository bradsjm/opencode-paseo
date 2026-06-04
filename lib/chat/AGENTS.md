# AGENTS.md

## Scope

This folder owns chat-room normalization, reserved labels, worker prompt augmentation, and passive room watching.

## Rules

- Keep the reserved label key `opencodePaseo.chatRoom` stable unless the whole repo is updated together.
- Put worker chat prompt text in `worker-room.ts`, not in tool or queue files.
- Keep `watch.ts` focused on room observation and inbox/nudge emission; do not move generic inbox logic here.
- Preserve the current no-history-replay posture: watchers seed from the latest message and watch forward.

## When editing

- If mention handling changes, verify both inbox insertion and nudge behavior still flow through shared state/notifier helpers.
- If chat-room metadata storage changes, update the corresponding state shape in `lib/state/types.ts` and hydration/watch callers together.
