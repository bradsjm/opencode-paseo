# Briefing Templates

Copy and tighten these templates for the selected pattern. Keep prompts self-contained; workers should not need hidden coordinator context.

## Coordinator Plan

```text
Paseo plan for <task-slug>

Goal: <final outcome>
Pattern: <single worker | advisor | independent reviewers | phased coding | loop | schedule | terminal | chunk split | bake-off>
Profiles: <profile choices from paseo_profile_list>
Coordinator cwd/branch: <path and branch>
Labels/chat: <labels and chatRoom if used>
Acceptance checks: <commands or evidence>
Safety constraints: <dirty state, protected files, destructive gates>
Workers:
- <role/chunk/variant>: scope=<owned>, avoid=<forbidden>, output=<report/artifact>
Attention plan: wait with <workerIds/waitFor/timeout>; inspect inbox on interruption.
Verification plan: <focused checks, integrated review, final checks>
Cleanup gate: archive only after validation and clean merge state.
```

## Worker Prompt

```text
You are a Paseo worker managed by a coordinator through the opencode-paseo plugin.

Objective: <specific outcome>
Context: <repo, cwd, branch/worktree, relevant files>
Owned scope: <files/subsystems>
Forbidden scope: <files/subsystems/actions>
Acceptance criteria: <observable requirements>
Verification: <commands/evidence to run or collect>
Coordination: <chatRoom instructions if any; use chat for progress/blockers/completion only>

Rules:
- Work only inside the assigned scope.
- Inspect relevant files before editing.
- Do not overwrite unrelated dirty user work.
- Do not merge, push, archive, delete, force-kill, or alter other workers/worktrees.
- Stop and report if ownership, permissions, destructive actions, or dirty state are unclear.
- Run verification where feasible; if a check fails, investigate within scope and report exact failure.

Final report:
- Changed files/artifacts.
- Implementation choices.
- Commands/checks run and results.
- Failures, skipped checks, and reasons.
- Risks or unresolved blockers.
- Commit hash or branch state, if commits are part of the assignment.
```

## Advisor Prompt

```text
Give a read-only second opinion.

Question: <decision/root cause/plan/risk>
Evidence: <facts, files, logs, constraints>
Output:
- Recommendation.
- Rationale and tradeoffs.
- Missing evidence or assumptions.
- Risks and simplest next validation.

Do not edit files or launch other workers.
```

## Bake-Off Candidate Addendum

```text
This is a competing same-spec implementation candidate.

Variant: <name/profile>
Base SHA: <sha>
Assigned worktree/branch: <worktree/branch>

Isolation rules:
- Do not read, copy, merge, rebase, or modify other candidate worktrees or the coordinator feature branch.
- Stage and commit only intended files for this candidate.
- Revert unrelated formatter churn before final report.

Report additionally:
- Commit hash.
- Validation evidence.
- Any deviations from the shared spec.
```
