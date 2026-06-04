# AGENTS.md

This is a single-package ESM TypeScript OpenCode plugin repo.

## Where the real wiring lives

- `index.ts` is the plugin entrypoint and assembly layer. Keep it as the place that wires `config -> logger -> state -> PaseoClient -> hydrate -> onEvent`.
- `lib/transport/` is the protocol boundary. Keep wire-level request/response/event types there instead of spreading them across the repo.
- `lib/hooks.ts` currently maps daemon event names/payload fields into inbox events. If protocol details change, update that mapping deliberately rather than duplicating it elsewhere.

## Commands

- Install deps: `pnpm install`
- Typecheck: `pnpm typecheck`
- Format: `pnpm format`
- Build: `pnpm build`
- Unit tests: `pnpm test`
- Integration test: `pnpm test:integration`
- Lint check: `pnpm lint`

## Verification gotchas

- `pnpm lint` is a Prettier check, not ESLint.
- `tsconfig.json` excludes `tests/`, so `pnpm typecheck` does **not** typecheck test files. Run the relevant tests when you touch test helpers or integration coverage.
- `pnpm build` depends on `jsonc-parser` being installed because `tsup.config.ts` bundles it via `noExternal: ["jsonc-parser"]`.

## Testing notes

- Unit tests use Node's built-in runner via `node --import tsx --test tests/*.test.ts`.
- `pnpm test:integration` requires the `opencode` CLI on `PATH`.
- The integration test boots a real OpenCode host from a temp project under `.opencode/plugins/`, loads this plugin from `index.ts`, and expects debug logs under the XDG config log path.

## Config caveats

- `getConfig()` auto-creates a global `~/.config/opencode/paseo.jsonc` when no global config exists. Sandbox `XDG_CONFIG_HOME`/`HOME` or `OPENCODE_CONFIG_DIR` in tests that exercise config loading.
- Preserve the localhost-only daemon boundary enforced by config validation unless the user explicitly changes requirements.
