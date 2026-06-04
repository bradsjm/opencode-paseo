# Plugin Tool Notes

Keep this file as the quick contract reference for current `opencode-paseo` tool behavior.

## Profiles

- `paseo_profile_list()` returns installed OpenCode profiles for this workspace.
- Prefer profile names over raw provider/model/mode choices for workers and schedules.
- `build` is the default implementation profile when available.

## Workers

- `paseo_worker_run({ prompt, cwd?, profile?, background?, worktreeName?, chatRoom?, labels?, timeout? })` creates an ephemeral non-detached worker. Foreground blocks by default; background returns immediately. Runs are best-effort canceled on tool abort/session cleanup.
- `paseo_worker_create({ cwd?, profile?, initialPrompt?, labels?, worktreeName?, chatRoom? })` queues a durable detached launch and returns a receipt immediately.
- Poll `paseo_worker_launch_status({ launchId })`; do not assume `paseo_worker_create` returned a worker ID.
- `paseo_worker_wait({ workerIds: string[], waitFor?: "any" | "all", timeout?: number })` requires known worker IDs, uses a global timeout, and may return early with `interruptedByNudge`. Interruption is attention, not completion.
- Nudge-worthy events include worker completion/failure/blocking/stall, chat mention, and permission request. Inspect before resuming orchestration.
- `paseo_worker_inspect({ workerId, includeActivity?, activityLimit? })` is the routing tool for worker state, chat room, worktree path, branch name, pending permissions, blocking action, progress, and recent activity.
- `paseo_worker_cancel({ workerId, forceKill: false })` cancels current work. `forceKill: true` is destructive permanent termination/removal.
- `paseo_worker_archive({ workerId })` removes a completed worker from active state.

## Chat

- Passing `chatRoom` to worker creation/run augments the worker prompt with room coordination instructions.
- Exact `@<worker-id>` mentions are plugin-native nudges for known owned workers; room titles, custom tokens, and self-mentions are not a substitute.
- Chat watchers do not replay old history when first attached; they seed from the latest message.
- Use chat for status/blockers/completion and exact attention pings, not as the main artifact store.

## Inbox And Permissions

- `paseo_inbox_status()` gives unread/blocking counts and breakdowns.
- `paseo_inbox_read({ unreadOnly?, kind?, resourceId?, cursor?, limit?, markRead? })` filters and optionally marks events read.
- Common filterable event kinds include worker lifecycle, permission, and daemon connection events. If an attention source is not enum-filterable, inspect worker state directly.
- `paseo_permission_respond({ workerId, permissionId, behavior, message?, interrupt?, selectedActionId? })` is the explicit approval/denial primitive for pending worker actions and updates local permission state.

## Worktrees

- Prefer `paseo_worker_create` with `worktreeName` for worker-owned isolated checkouts.
- Use `paseo_worktree_create` only when a managed worktree is needed before a worker launch or for special setup.
- `paseo_worktree_list({ cwd? , repoRoot? })` requires at least one project context.
- `paseo_worktree_archive({ worktreePath?, repoRoot?, branchName?, cwd? })` is destructive; confirm merge/cleanliness first. It may remove daemon-reported workers from local state.

## Terminals

- `paseo_terminal_create` binds a terminal to the current OpenCode session.
- `paseo_terminal_send_lines` appends newlines and is best for full commands.
- `paseo_terminal_send_input` sends raw keystrokes.
- `paseo_terminal_capture` returns bounded output and line counts.
- Capture important output before `paseo_terminal_kill`.

## Loops

- `paseo_loop_run` requires a prompt, at least one verification mechanism (`verifyPrompt` or non-empty `verifyChecks`), and at least one positive stop bound (`maxIterations` or `maxTimeMs`).
- Use loop list/inspect/logs/stop tools to observe and control daemon-native loops.

## Schedules

- `paseo_schedule_create` supports `every` and `cron` cadences and `self`, `agent`, or `new-agent` targets.
- `new-agent` schedules require a profile and cwd; the plugin resolves profile provider/model/mode and validates daemon provider availability. Treat schedules as profile-backed orchestration, not ad hoc model invocation.
- Use `paseo_schedule_logs` and inbox tools to inspect async runs.
