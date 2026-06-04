# AGENTS.md

## Scope

This folder owns inbox read/query helpers, stable ID helpers, and summary shaping.

## Rules

- Keep mutation logic out of this folder; write paths belong in `lib/state/inbox-state.ts`.
- Preserve deterministic special IDs when read-state correlation depends on them.
- Keep summary truncation centralized so inbox output remains consistent across hydration, hooks, and chat watchers.
