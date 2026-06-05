# `lib/worker-launch`

Queued durable worker-launch control, including rollback-aware failure assessment for worktree-backed launches.

## Files

- `queue.ts` implements FIFO launch receipts, launch-status snapshots, daemon create calls, conservative worktree rollback assessment, fallback bookkeeping, and owner nudges.

## Responsibilities

- Serialize detached worker launches through a single active launch slot.
- Keep `launchId` generation, reserved launch/session/worktree labels, and queue bookkeeping centralized.
- Assess failed worktree-backed launches against current daemon worktree data and auto-archive only when ownership is unambiguous.
- Record created workers back into plugin state so later tools and events can resolve ownership.

## Key integration points

- `lib/tools/worker.ts` queues launches and reads launch status.
- `index.ts` constructs one queue controller for the plugin lifecycle.
- `lib/chat/worker-room.ts` supplies the reserved chat-room label used during launches.
