# `lib/worker-launch`

Queued durable worker-launch control.

## Files

- `queue.ts` implements FIFO launch receipts, launch-status snapshots, daemon create calls, fallback bookkeeping, and owner nudges.

## Responsibilities

- Serialize detached worker launches through a single active launch slot.
- Keep `launchId` generation, reserved launch/session/worktree labels, and queue bookkeeping centralized.
- Record created workers back into plugin state so later tools and events can resolve ownership.

## Key integration points

- `lib/tools/worker.ts` queues launches and reads launch status.
- `index.ts` constructs one queue controller for the plugin lifecycle.
- `lib/chat/worker-room.ts` supplies the reserved chat-room label used during launches.
