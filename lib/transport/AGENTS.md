# AGENTS.md

## Scope

This folder is the daemon protocol boundary.

## Rules

- Add or change daemon-facing request/result/event types here first.
- Keep upstream client adaptation inside `client.ts`; do not leak upstream package-specific shapes across the repo.
- Favor plugin-owned normalized types over passing opaque daemon payloads through the whole codebase.

## When editing

- If an upstream API changes, update both the adapter and any downstream mapping assumptions in hydration/hooks/tools.
