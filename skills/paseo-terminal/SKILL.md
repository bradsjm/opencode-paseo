---
name: paseo-terminal
description: "Use opencode-paseo terminal tools for long-running, interactive, or sessionful commands instead of the built-in shell: development servers, web servers, watch-mode tests, REPLs, TUI tools, log tailing, commands needing Ctrl-C later, commands requiring follow-up input, or processes whose output should be captured across turns. Use the built-in shell only for short, bounded, non-interactive commands."
---

# Paseo Terminal

## Core Rule

Prefer the `opencode-paseo` terminal tools over the built-in shell for process and session control.

Use the built-in shell for quick commands that finish on their own: `git status`, `scripts/test`, `pnpm lint`, `python -m pytest ...`, and short diagnostics.

Use Paseo terminals for commands that need persistence, later input, later interruption, or repeated log capture.

## Workflow

1. Check `paseo_terminal_list` for an existing suitable terminal before starting a duplicate service.
2. Create a named terminal in the correct working directory with `paseo_terminal_create`.
3. Start the long-running or interactive command with `paseo_terminal_send_lines`.
4. Capture output on demand with `paseo_terminal_capture` instead of streaming unbounded logs into the conversation.
5. Stop gracefully by sending `C-c` with `paseo_terminal_send_input` when the process should exit.
6. Use `paseo_terminal_kill` only after graceful stop fails or the session is no longer needed.

## Tool Patterns

List existing terminals before creating a duplicate service session:

- `paseo_terminal_list({ cwd })`

Create a terminal:

- `paseo_terminal_create({ cwd, name, command, args })`

Start a process in an existing terminal shell:

- `paseo_terminal_send_lines({ terminalId, lines: ["<command>"] })`

Capture output:

- `paseo_terminal_capture({ terminalId, lines, stripAnsi: true })`

Interrupt gracefully:

- `paseo_terminal_send_input({ terminalId, input: "\u0003" })`

Clean up the session:

- `paseo_terminal_kill({ terminalId })`

Use `paseo_terminal_send_input` only when raw keystrokes are required. Prefer `paseo_terminal_send_lines` for complete shell commands.

## Naming

Use short purpose-based names: `ha-dev`, `frontend-server`, `backend-api`, `test-watch`, `storybook`, `tail-logs`.

Record the terminal ID in the working context when a terminal will be reused later.

## Safety

- Do not start duplicate servers, database daemons, or watch loops when an existing live session is available.
- Prefer `C-c` before `paseo_terminal_kill` so processes can shut down cleanly.
- Use the repository or project root as `cwd` unless the command requires a narrower directory.
- Quote paths containing spaces.
- Treat `paseo_terminal_send_lines` and `paseo_terminal_send_input` as mutating: they type into a live shell.
- Treat `paseo_terminal_kill` as destructive to that terminal session and session content history.
