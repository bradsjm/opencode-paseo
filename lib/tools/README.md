# `lib/tools`

OpenCode tool definitions for the plugin.

## Files

- `status.ts` exposes plugin/daemon status.
- `chat.ts` exposes chat-room operations.
- `inbox.ts` exposes inbox read/status queries.
- `terminal.ts` exposes terminal lifecycle and I/O.
- `permission.ts` exposes permission responses.
- `profile.ts` exposes OpenCode profile discovery.
- `worker.ts` exposes worker lifecycle, queue status, wait, inspect, and update operations.
- `worktree.ts` exposes git worktree operations.
- `loop.ts` exposes daemon-native loop operations.
- `schedule.ts` exposes daemon-managed schedule operations.
- `index.ts` re-exports tool factories.

## Responsibilities

- Define tool descriptions and argument schemas.
- Normalize and validate tool inputs before transport calls.
- Shape returned payloads for OpenCode without becoming the source of truth for state or daemon semantics.

## Notes

- The worker tool surface intentionally separates queued detached launches (`paseo_worker_create`) from ephemeral non-detached runs (`paseo_worker_run`).
- `paseo_worker_launch_status` is the main follow-up path for queued launches and now includes rollback metadata for failed worktree-backed launches.
- The loop tool surface intentionally requires verification and stop bounds before calling the daemon.
