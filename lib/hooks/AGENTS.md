# AGENTS.md

## Scope

This folder owns translation from daemon events into plugin behavior.

## Rules

- Add or change daemon event handling here first, not ad hoc inside tools or state helpers.
- Preserve the distinction between pure state sync and inbox-producing events.
- Reuse shared summary truncation, blocking metadata, and notifier helpers instead of duplicating that logic.
- When daemon payloads are partial, merge them with current local worker state instead of dropping existing fields.

## When editing

- If you add a new daemon event type, update transport types and this handler together.
- If you change blocking behavior, verify the inbox metadata still supports downstream permission/action workflows.
