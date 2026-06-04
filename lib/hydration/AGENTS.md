# AGENTS.md

## Scope

This folder owns initial daemon snapshot ingestion during plugin startup.

## Rules

- Keep hydration idempotent and snapshot-based.
- Do not replay arbitrary daemon history here.
- Seed only the actionable inbox items the plugin intentionally surfaces on startup.
- Preserve the ordering: capabilities first, then workers, then terminals, then connection status.

## When editing

- If hydration begins storing new state, update `HydrationResult` counts and the corresponding state structures together.
