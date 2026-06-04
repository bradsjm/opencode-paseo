# AGENTS.md

## Scope

This folder owns OpenCode-facing tool contracts.

## Rules

- Keep argument validation close to the tool that needs it.
- Reuse transport, state, profile, notifier, and chat helpers instead of reimplementing those concerns per tool.
- Keep tool descriptions aligned with actual runtime behavior; if behavior changes, update the description in the same patch.
- Prefer returning structured JSON payloads over lossy formatted text.

## When editing

- If a tool becomes stateful, check whether that logic belongs in `lib/state/`, `lib/hooks/`, or `lib/worker-launch/` instead.
