# AGENTS.md

This is a single-package ESM TypeScript OpenCode plugin repo.

## Where the real wiring lives

- `index.ts` is the plugin entrypoint and assembly layer. Keep it as the place that wires `config -> logger -> state -> PaseoClient -> hydrate -> onEvent`.
- `lib/transport/` is the protocol boundary. Keep wire-level request/response/event types there instead of spreading them across the repo.
- `lib/hooks.ts` owns OpenCode hook entrypoints; `lib/hooks/daemon-events.ts` is the daemon-event mapping layer. If protocol details change, update that mapping deliberately rather than duplicating it elsewhere.
- `lib/tools/` owns OpenCode tool definitions and argument contracts. Avoid moving transport, state, or mapping logic into tool files unless it is specific to tool input/output shaping.
- `lib/state/` owns the in-memory model for sessions, workers, terminals, chat rooms, inbox items, and launch bookkeeping.
- `lib/chat/` owns reserved chat-room labels, worker prompt augmentation, and chat-watch behavior.
- `lib/worker-launch/queue.ts` is the only durable queued worker-launch controller; keep FIFO semantics and launch bookkeeping centralized there.

## Nested docs

- Each multi-file `lib/*` folder has its own `README.md` and `AGENTS.md`. Read the closest one before making localized changes.
- Use the root docs for repo-wide rules and the folder docs for boundary-specific invariants.

## Commands

- Install deps: `pnpm install`
- Typecheck: `pnpm typecheck`
- Format: `pnpm format`
- Build: `pnpm build`
- Unit tests: `pnpm test`
- Integration test: `pnpm test:integration`
- Lint check: `pnpm lint`

## Post-edit verification

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:integration`
- `pnpm build`

## Testing notes

- Unit tests use Node's built-in runner via `node --import tsx --test tests/*.test.ts`.
- The integration test boots a real OpenCode host from a temp project under `.opencode/plugins/`, loads this plugin from `index.ts`, and expects debug logs under the XDG config log path.
- `pnpm typecheck` does not verify Markdown or local AGENTS/README content; run `pnpm lint` after documentation edits because it is the repo's formatting gate.

## Config caveats

- `getConfig()` auto-creates a global `~/.config/opencode/paseo.jsonc` when no global config exists. Sandbox `XDG_CONFIG_HOME`/`HOME` or `OPENCODE_CONFIG_DIR` in tests that exercise config loading.
- Preserve the localhost-only daemon boundary enforced by config validation unless the user explicitly changes requirements.
