# Paseo Patterns

Use the smallest pattern that gives the coordinator useful context separation, durability, or parallelism. Start with one agent and add workers only when the task benefits from isolation, async durability, independent parallelism, adversarial review, or worktree-backed comparison.

## Single Helper

Use `paseo_worker_run` for a bounded task where the coordinator can consume one final result.

- Foreground is best when the result is needed now.
- Background is acceptable when the task may outlive the turn and labels make it trackable.
- Ask for a concise final report, not a stream of intermediate thoughts.

## Background Detached Task

Use `paseo_worker_create` when the worker should survive beyond the current turn or needs a worktree/chat room.

1. `paseo_profile_list`.
2. `paseo_worker_create({ cwd, profile, labels, worktreeName?, chatRoom?, initialPrompt })`.
3. Poll `paseo_worker_launch_status({ launchId })` until `workerId` is available or failed.
4. Wait with `paseo_worker_wait({ workerIds: [workerId], waitFor: "all", timeout })`.
5. If wait is interrupted, inspect inbox and worker state before sending more work.
6. Inspect and validate before acting on output.

## Advisor

Use one read-only worker for a second opinion on architecture, root cause, plan quality, or risk. Give it a self-contained brief and ask for tradeoffs, missing evidence, and recommended next action. The coordinator implements or delegates after synthesizing.

## Independent Reviewers + Synthesis

Use two independent read-only workers only when contrasting perspectives are worth the cost. Give both the same evidence and output schema, vary profile or stance if useful, then synthesize. Do not create a free-form committee chat by default; the coordinator compares independent reports.

## Phased Coding Orchestration

Default to serial phases:

1. research/explore;
2. plan;
3. implement;
4. verify;
5. integrated review;
6. deliver.

Parallelize only independent chunks, independent reviewers, long-running checks, or bake-off candidates. For isolated implementation, read `parallel-worktrees.md` first.

## Verified Loop

Use `paseo_loop_run` when repeated worker attempts should continue until verification passes or a bound is hit.

- Provide a non-empty worker prompt.
- Provide at least one verification mechanism: `verifyPrompt` or non-empty `verifyChecks`.
- Provide at least one positive stop bound: `maxIterations` or `maxTimeMs`.
- Inspect loop logs before changing direction or stopping.

Good fits: babysit a flaky PR checklist, drive tests green, repeatedly apply a known remediation with independent verification.

## Recurring Automation

Use `paseo_schedule_create` for repeated checks or reports.

- Choose `self`, existing `agent`, or `new-agent` target deliberately.
- For `new-agent`, provide a valid profile and cwd; avoid ad hoc provider/model scheduling when a profile can express the target.
- Inspect `paseo_schedule_logs` and inbox events for outcomes.
- Pause or delete schedules that no longer have a clear owner.

## Terminal-Backed Process

Use `paseo_terminal_*` for dev servers, watch tests, REPLs, TUIs, log tails, or any command needing later input/interruption.

- List first to avoid duplicates.
- Use `send_lines` for complete commands.
- Capture bounded output before deciding.
- Send Ctrl-C before `paseo_terminal_kill`; capture important output before kill.

## Attention And Recovery

- Treat `paseo_inbox_status` and `paseo_inbox_read` as the attention dashboard before treating silence as failure.
- Use `paseo_worker_inspect({ includeActivity: true })` as the routing/progress/blocked-state check before continuing, redirecting, canceling, or archiving.
- If `paseo_worker_wait` returns `interruptedByNudge`, inspect the nudge event and affected worker before continuing.
- Use `paseo_permission_respond` as an explicit approval flow: allow only actions that match the worker scope; deny with a reason when scope or safety is unclear.
- For failed launches, inspect launch status, profile availability, cwd/worktree assumptions, and daemon health before retrying.
- Prefer scoped follow-up messages over cancellation. Cancel with `forceKill: false` first; reserve force-kill for unrecoverable or explicitly destructive cases.
