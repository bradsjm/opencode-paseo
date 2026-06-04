# Coordinator And Worker Roles

Use a supervisor-worker topology unless the user explicitly asks for a different shape. The coordinator owns control, context selection, safety, and synthesis; workers own scoped execution.

## Coordinator Owns

- Apply single-agent-first topology selection; justify multi-agent only for context isolation, durable async work, independent parallelism, high-risk review, or bake-off comparison.
- Select the pattern: single worker, durable async worker, advisor/reviewer, phased project, loop, schedule, terminal, chunk split, or bake-off.
- Inspect project state before orchestration: repository instructions, git status, daemon status, profiles, existing workers, worktrees, inbox, and terminals.
- Write the worker brief with objective, scope, output schema, verification, allowed tools, stop/escalation conditions, and effort bounds.
- Choose profiles with `paseo_profile_list`; prefer `build` for implementation unless another installed profile clearly fits.
- Launch workers with clear labels and optional `chatRoom`; record launch IDs, worker IDs, worktree names, branch names, and verification plans.
- Poll queued launches with `paseo_worker_launch_status` until each worker ID exists.
- Wait and route attention with `paseo_worker_wait`, `paseo_worker_inspect`, `paseo_inbox_status/read`, and `paseo_permission_respond`.
- Set stop bounds for waits, loops, schedules, and worker effort. Do not let open-ended orchestration run without an attention plan.
- Own human checkpoints for approval, destructive operations, merge/PR decisions, permission scope, and acceptance changes.
- Decide when to send follow-up instructions, cancel, archive, merge, schedule, stop loops, or kill terminals.
- Review worker outputs as untrusted: inspect diffs/artifacts, run validation, synthesize conclusions, and report risks to the user.
- Own advisor/code-review usage unless a worker is explicitly assigned a review role or hits a high-risk blocker.

## Workers Own

- Execute the assigned scoped task only.
- Read the relevant repository files before editing.
- Respect owned and forbidden paths, branches, worktrees, tools, and effort bounds.
- Run focused verification where feasible and report exact commands/results.
- Return structured output matching the coordinator's report schema.
- Post only progress, blockers, and completion in the assigned chat room unless explicitly asked for more.
- Use exact `@<worker-id>` mentions only when told to alert a specific coworker or coordinator-tracked worker.
- Stop and report instead of guessing when scope, dirty state, permissions, or cross-worker ownership is unclear.
- Produce a final report with changed files, validation, skipped checks, risks, commits/artifacts, and unresolved blockers.

## Coordinator-Only By Default

- Creating or archiving shared worktrees.
- Merging worker branches into the feature branch.
- Merging feature branches into `main`/`master`, pushing, or opening PRs.
- Responding to permissions that affect shared state or destructive operations.
- Force-killing workers, killing terminals, deleting schedules, or stopping loops.
- Bulk worker operations. Always filter to task labels and exclude the coordinator session.

## Chat Room Discipline

Treat `chatRoom` as a low-bandwidth coordination and attention channel:

- good: progress, blockers, final completion, exact mention pings;
- bad: long reasoning transcripts, primary artifacts, merge decisions, or hidden acceptance changes.

When substantial information matters, require a final report, diff, log capture, or artifact path.
