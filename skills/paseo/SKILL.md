---
name: paseo
description: "Use the opencode-paseo plugin tools to coordinate Paseo workers, profiles, chat rooms, inbox/permissions, terminals, loops, schedules, and isolated worktrees. Use when orchestrating agent work through `paseo_*` tools: advisor or independent-reviewer consultation, large phased tasks, async durable workers, verified loops, recurring automations, terminal-backed processes, parallel chunk splits, or model bake-offs."
---

# Paseo Orchestration

Use this project skill as the single coordinator playbook for agentic work through the local `opencode-paseo` plugin. Prefer `paseo_*` tools over generic CLI or MCP assumptions, keep the coordinator in control, and load references only when the selected pattern needs detail.

## Start Here

1. Check daemon and existing state with `paseo_status`, then `paseo_profile_list` before launching workers.
2. Apply **single-agent first**: choose the smallest topology that fits the task; do not make routine coding work multi-agent by default.
3. For coding, prefer serial phases first: inspect/research -> plan -> implement -> verify -> review. Parallelize only independent chunks, reviews, long checks, or bake-offs.
4. Write a self-contained brief before delegating: objective, scope, relevant files, allowed edits, verification, output contract, stop bounds, blockers, and effort bounds.
5. Use labels (`project`, `chunk`, `variant`, `role`) and optional `chatRoom` for durable or multi-worker work.
6. Monitor through `paseo_worker_wait`, `paseo_worker_inspect`, `paseo_inbox_status/read`, and permission responses; treat wait interruption as attention needed, not success.
7. Verify worker output yourself before synthesis, merge, archive, or destructive cleanup.

## Capability Chooser

| Need                                      | Use                                                                          | Notes                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| One bounded helper task                   | `paseo_worker_run`                                                           | Foreground blocks by default; use background only when you can track the worker later. |
| Durable async worker                      | `paseo_worker_create` -> `paseo_worker_launch_status` -> `paseo_worker_wait` | Queued launch returns `launchId` first; poll until `workerId` exists.                  |
| Second opinion or adversarial review      | One or two independent scoped workers                                        | Coordinator synthesizes; workers do not edit unless explicitly asked.                  |
| Large phased project                      | Serial phases first: research -> plan -> implement -> verify                 | Parallelize only independent chunks, reviews, checks, or bake-offs.                    |
| Parallel implementation or model bake-off | Isolated worktrees                                                           | Advanced mode; read `references/parallel-worktrees.md` first.                          |
| Keep trying until checks pass             | `paseo_loop_run`                                                             | Require verification (`verifyPrompt` or `verifyChecks`) and stop bounds.               |
| Recurring automation                      | `paseo_schedule_create`                                                      | Use profile-backed `new-agent` runs when spawning agents.                              |
| Interactive or long-running command       | `paseo_terminal_*`                                                           | Capture before kill; prefer send-lines for complete commands.                          |

## Coordinator Defaults

- Keep one coordinator responsible for user-facing decisions, profile choice, worker launches, labels, chat rooms, waits, permissions, synthesis, verification, mergeback, and cleanup.
- Use workers as isolated specialists with explicit output contracts. Substantive results belong in final reports, diffs, terminal captures, or artifacts.
- Use chat rooms for progress, blockers, completion, and exact `@<worker-id>` attention pings; do not rely on chat as the primary reasoning or artifact bus.
- Prefer profiles from `paseo_profile_list`; do not hard-code provider/model fields unless the tool specifically requires them.
- Prefer bounded waits over polling loops. If a wait is interrupted by a nudge, inspect inbox and the affected worker before sending more work.
- Do not archive worktrees, force-kill workers, or kill terminals until useful output is captured and safety checks pass.

## Worker Brief Minimum

Include:

- objective and acceptance criteria;
- owned scope and forbidden scope;
- relevant paths, branch/worktree context, and known constraints;
- tools or sources to prefer and what not to use;
- required verification and what to report if checks fail;
- final report fields: changed files, commands/results, failures/skips, risks, commits/artifacts, and blockers;
- escalation rules: stop for unclear ownership, unexpected dirty state, permission ambiguity, destructive actions, or cross-worker conflicts.

See `references/briefing.md` for copyable templates.

## Load References As Needed

- `references/roles.md`: coordinator vs worker responsibilities and boundaries.
- `references/patterns.md`: recipes for advisor, independent reviewers, phased coding work, loops, schedules, terminals, and attention handling.
- `references/plugin-notes.md`: current `opencode-paseo` tool contracts and gotchas.
- `references/parallel-worktrees.md`: advanced fan-out/fan-in chunk splits and model bake-offs.
- `references/briefing.md`: coordinator plans and worker prompt templates.
- `references/design-basis.md`: compact source basis for the orchestration guidance.
