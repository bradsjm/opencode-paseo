# AGENTS.md

## Scope

This folder owns the durable queued worker-launch path.

## Rules

- Preserve FIFO queue semantics and the single active launch invariant.
- Keep reserved launch/session/worktree labels stable unless every consumer is updated together.
- Record both success and failure back into launch status snapshots.
- Nudge the owning OpenCode session from here when launch state changes.

## When editing

- If launch bookkeeping changes, verify tool payloads, state updates, and post-create worker observation still agree.
