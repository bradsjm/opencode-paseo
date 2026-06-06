# AGENTS.md

## Scope

This folder owns OpenCode-facing tool contracts.

## Rules

- Keep argument validation close to the tool that needs it.
- Reuse transport, state, profile, notifier, and chat helpers instead of reimplementing those concerns per tool.
- When optional tool inputs need normalization, prefer a shared helper layer under `lib/tools/` over ad hoc per-tool `null`/`undefined` checks.
- Treat raw OpenCode tool args as untrusted at the tool boundary: optional fields may arrive omitted or explicitly `null`, so normalize before validation or transport shaping.
- Keep that normalization shallow and tool-facing; do not move nullable-input workarounds into `lib/transport/` or broad recursive payload scrubbers.
- Preserve intentional `null` semantics when a tool uses them to clear upstream state; do not collapse those nested clear-value fields with generic optional-input helpers.
- Keep tool descriptions aligned with actual runtime behavior; if behavior changes, update the description in the same patch.
- Prefer returning structured JSON payloads over lossy formatted text.

## When editing

- If a tool becomes stateful, check whether that logic belongs in `lib/state/`, `lib/hooks/`, or `lib/worker-launch/` instead.
- If a new optional-input pattern appears, extend the shared tool-input helper layer first so tool implementations can keep working with stable internal shapes.
