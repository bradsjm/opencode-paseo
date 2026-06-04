# AGENTS.md

## Scope

This folder owns the canonical in-memory state model for the plugin.

## Rules

- Add new plugin state fields in `types.ts` first, then update `createPluginState()` and `resetPluginState()`.
- Keep cross-session ownership logic centralized here.
- Preserve the distinction between durable worker launches and ephemeral worker runs.
- Do not hide transport or tool decisions inside state helpers; keep them data-oriented.

## When editing

- If worker or terminal lifecycle behavior changes, verify session bindings, unread tracking, and cleanup helpers together.
