# Parallel Worktrees

Use this advanced mode only for large implementation work where isolated parallelism is worth the coordination and merge risk.

## Modes

- **Chunk split**: workers implement different scoped chunks that will be combined into one feature branch.
- **Model bake-off**: workers receive the same spec with different profiles/models; the coordinator compares candidates and merges only the winner unless the user asks to combine.

Do not use this mode for small edits, quick diagnostics, or tasks with heavy same-file coordination unless the plan names a conflict strategy.

## Invariants

- Preserve user work: inspect dirty state before start, merge, and cleanup.
- Establish one feature branch as the fan-in target before worker worktrees are created.
- Record immutable base SHA, feature branch, task slug, labels, worker IDs, worktree names, and merge order.
- Keep workers isolated: no worker merges to the feature branch, archives shared resources, pushes, or edits another worktree.
- Treat worker output as untrusted until coordinator review and verification.
- Merge one worker branch at a time. Stop on conflicts until resolved and verified.
- User permission is required before merging the feature branch into `main`/`master` or creating a PR.

## Preflight

1. Inspect repo instructions, `git status`, current branch, and recent commits.
2. Check `paseo_status`, `paseo_worker_list`, and `paseo_worktree_list({ cwd })`.
3. If on `main`/`master`, create a task feature branch. If already on a non-main branch, use it as the feature branch. If detached or dirty state is unclear, ask the user.
4. Use advisor before splitting ambiguous work or launching a bake-off with unclear criteria.

## Plan A Chunk Split

Record:

- final outcome and acceptance checks;
- task slug, feature branch, immutable base SHA;
- chunks with owned scope, expected files, forbidden files, verification, final report fields;
- shared interfaces and any same-file conflict owner/merge order.

## Plan A Bake-Off

Record:

- shared spec, acceptance checks, and judging criteria;
- task slug, feature branch, immutable base SHA;
- exact profile/model variants and labels such as `project=<slug>` and `variant=<name>`;
- rule that candidates must not read, copy, merge, rebase, or modify other candidate worktrees;
- final report fields: changed files, choices, validation, failures/skips, risks, commit hash, artifacts, and whether advisor/review was invoked.

Judge code quality/correctness first, then process efficiency. Penalize isolation violations, unrelated churn, dirty output, validation failure, and poor final reports.

## Launch

Prefer queued durable workers with worktrees:

- Chunk: `paseo_worker_create({ cwd, profile: "build", worktreeName: "<slug>-<chunk>", labels: { project: "<slug>", chunk: "<chunk>" }, chatRoom?, initialPrompt })`.
- Bake-off: `paseo_worker_create({ cwd, profile: "<profile>", worktreeName: "<slug>-<variant>", labels: { project: "<slug>", variant: "<variant>" }, chatRoom?, initialPrompt: "<same shared prompt>" })`.

Poll every launch receipt with `paseo_worker_launch_status` until each worker ID is known or failed.

## Monitor And Review

- Use `paseo_worker_wait({ workerIds, waitFor: "any" | "all", timeout })` for bounded waits.
- On interruption, inspect inbox and the affected worker.
- Inspect each completed worker, locate its worktree/branch, check git status, diff from the immutable base or merge base, and run focused verification.
- Do not merge dirty, unreviewed, failing, unexplained, or out-of-scope output.
- In bake-off mode, run the same validation for every viable candidate and document the winner.

## Merge Back

Before each merge, confirm:

- feature branch is clean;
- worker branch is clean or intentionally committed;
- changes match the assigned chunk/candidate;
- branch has not already been merged.

Use normal merge unless the user or repo convention requires squash. Do not rebase by default. After every merge, run relevant verification before the next merge. Resolve conflicts deliberately on the feature branch and do not proceed until clean.

## Final Validation And Cleanup

After required work is merged:

1. Run the broadest practical validation.
2. Run integrated code review on the fully merged feature branch.
3. Address findings and rerun relevant checks.
4. Inspect final status/diff from the original base.
5. Check for running labeled workers and unresolved reports.
6. Ask the user whether to merge into `main`/`master` or create a PR only if validation is clean.

Cleanup only after validation and merge/PR decisions are safe:

- Archive completed workers.
- Archive worktrees only after branch merged and worktree clean.
- Leave failed, partial, or losing bake-off worktrees until the user confirms no salvage is needed.
- Never force-kill or bulk-archive ambiguous targets.
