# `lib/transport`

Protocol boundary between the plugin and the Paseo daemon client.

## Files

- `client.ts` adapts the upstream JavaScript client into plugin-friendly operations.
- `types.ts` defines the plugin-owned transport/request/result/event types used across the repo.
- `index.ts` re-exports transport types and client helpers.

## Responsibilities

- Isolate upstream client and payload quirks from the rest of the plugin.
- Keep plugin-owned event and result types stable even if upstream shapes drift.
- Normalize daemon interactions before they reach tools, hydration, or hooks.

## Notes

- `types.ts` is intentionally the plugin's view of the daemon, not a literal wire-format mirror.
