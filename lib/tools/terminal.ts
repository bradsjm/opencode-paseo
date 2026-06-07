import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import { getOrCreateSession, recordCreatedTerminal, unbindTerminalFromSessions } from "../state/state.js"
import { collapseNull, compactDefined, nullableOptional, optionalNumber } from "./args.js"

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Terminal create aborted")
  }
}

// ─── Terminal List Tool ──────────────────────────────────────────────────────

/**
 * Create the tool that lists daemon-reported terminals.
 *
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createTerminalListTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "List daemon-reported Paseo terminals. By default lists terminals for the current working directory; " +
      "set all to true to request the daemon's unfiltered terminal list.",
    args: {
      cwd: nullableOptional(tool.schema.string()).describe("Filter terminals by working directory"),
      all: nullableOptional(tool.schema.boolean()).describe("List all daemon-reported terminals without a cwd filter"),
    },
    async execute(args, context: ToolContext) {
      const all = collapseNull(args.all)
      const cwd = all ? undefined : (collapseNull(args.cwd) ?? context.directory)
      logger.info("Tool: paseo_terminal_list invoked", { cwd, all })

      const terminals = await client.listTerminals(cwd)

      return {
        title: "Paseo Terminals",
        output: JSON.stringify({ terminals, count: terminals.length }, null, 2),
      }
    },
  })
}

// ─── Terminal Create Tool ────────────────────────────────────────────────────

/**
 * Create the tool that opens a new terminal session.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createTerminalCreateTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  let terminalCreateTail: Promise<void> = Promise.resolve()

  function serializeTerminalCreate<T>(operation: () => Promise<T>): Promise<T> {
    const run = terminalCreateTail.then(operation, operation)
    terminalCreateTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return tool({
    description: "Create a new Paseo terminal session. The terminal is bound to the current opencode session.",
    args: {
      cwd: tool.schema
        .string()
        .nullable()
        .optional()
        .describe("Working directory for the terminal (defaults to session directory)"),
      name: nullableOptional(tool.schema.string()).describe("Human-readable name for the terminal"),
      agentId: nullableOptional(tool.schema.string()).describe("Associate terminal with a specific agent"),
    },
    async execute(args, context: ToolContext) {
      const cwd = collapseNull(args.cwd) ?? context.directory
      const name = collapseNull(args.name)
      const agentId = collapseNull(args.agentId)
      logger.info("Tool: paseo_terminal_create invoked", { cwd, name })
      throwIfAborted(context.abort)

      return serializeTerminalCreate(async () => {
        throwIfAborted(context.abort)

        const result = await client.createTerminal({ cwd, ...compactDefined({ name, agentId }) })

        // Bind terminal to the session
        const session = getOrCreateSession(state, context.sessionID, context.worktree)
        recordCreatedTerminal(state, context.sessionID, {
          id: result.id,
          title: result.title ?? result.name ?? result.id,
          cwd: result.cwd ?? cwd,
          status: "running",
          lineCount: 0,
          lastReadCursor: 0,
        })

        logger.info("Terminal created", {
          terminalId: result.id,
          sessionId: session.opencodeSessionId,
        })

        return {
          title: "Terminal Created",
          output: JSON.stringify(
            {
              id: result.id,
              name: result.name,
              title: result.title,
              cwd: result.cwd ?? cwd,
              status: "running",
            },
            null,
            2,
          ),
        }
      })
    },
  })
}

// ─── Terminal Capture Tool ───────────────────────────────────────────────────

/**
 * Create the tool that captures terminal output.
 *
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createTerminalCaptureTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Capture output from a Paseo terminal. Returns daemon-native lines and totalLines metadata. " +
      "Use scrollback to request capture from the start of the daemon buffer.",
    args: {
      terminalId: tool.schema.string().describe("ID of the terminal to capture"),
      start: nullableOptional(tool.schema.number().int()).describe("Start line/range passed to the daemon capture API"),
      end: nullableOptional(tool.schema.number().int()).describe("End line/range passed to the daemon capture API"),
      scrollback: nullableOptional(tool.schema.boolean()).describe(
        "Capture from daemon scrollback by setting start to 0",
      ),
      stripAnsi: nullableOptional(tool.schema.boolean()).describe(
        "Strip ANSI escape codes from output (default: true)",
      ),
    },
    async execute(args) {
      const start = optionalNumber(args.start)
      const end = optionalNumber(args.end)
      const scrollback = collapseNull(args.scrollback)
      const stripAnsi = collapseNull(args.stripAnsi) ?? true
      logger.info("Tool: paseo_terminal_capture invoked", {
        terminalId: args.terminalId,
        start,
        end,
        scrollback,
      })

      const capture = await client.captureTerminal({
        terminalId: args.terminalId,
        stripAnsi,
        ...(scrollback ? { start: 0 } : compactDefined({ start })),
        ...compactDefined({ end }),
      })

      return {
        title: `Terminal Capture: ${args.terminalId}`,
        output: JSON.stringify(capture, null, 2),
      }
    },
  })
}

// ─── Terminal Send Input Tool ────────────────────────────────────────────────

/**
 * Create the tool that sends raw input to a terminal.
 *
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createTerminalSendInputTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Send raw input (keystrokes/text) to a running Paseo terminal. " +
      "Characters are sent verbatim — this tool does not interpret escape sequences. " +
      "To press Enter, include an actual newline character in the JSON string value.",
    args: {
      terminalId: tool.schema.string().describe("ID of the terminal to send input to"),
      input: tool.schema
        .string()
        .describe("Raw text or keystrokes to send. Characters are sent as-is with no escape-sequence interpretation."),
    },
    execute(args) {
      return Promise.resolve().then(() => {
        logger.info("Tool: paseo_terminal_send_input invoked", {
          terminalId: args.terminalId,
          inputLength: args.input.length,
        })

        client.sendTerminalInput(args.terminalId, args.input)

        return {
          title: "Input Sent",
          output: JSON.stringify(
            {
              terminalId: args.terminalId,
              sent: args.input.length,
            },
            null,
            2,
          ),
        }
      })
    },
  })
}

// ─── Terminal Send Lines Tool ────────────────────────────────────────────────

/**
 * Create the tool that sends multiple command lines to a terminal.
 *
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createTerminalSendLinesTool(client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Send one or more command lines to a running Paseo terminal. " +
      "Lines are joined with newlines and a trailing newline is appended so each command executes. " +
      "Use this instead of paseo_terminal_send_input when sending complete shell commands.",
    args: {
      terminalId: tool.schema.string().describe("ID of the terminal to send lines to"),
      lines: tool.schema
        .array(tool.schema.string())
        .min(1)
        .describe("Command lines to send. Each line is separated by a newline."),
    },
    execute(args) {
      return Promise.resolve().then(() => {
        logger.info("Tool: paseo_terminal_send_lines invoked", {
          terminalId: args.terminalId,
          lineCount: args.lines.length,
        })

        const joined = args.lines.join("\n") + "\n"

        client.sendTerminalInput(args.terminalId, joined)

        return {
          title: "Lines Sent",
          output: JSON.stringify(
            {
              terminalId: args.terminalId,
              lineCount: args.lines.length,
              sent: joined.length,
            },
            null,
            2,
          ),
        }
      })
    },
  })
}

// ─── Terminal Kill Tool ──────────────────────────────────────────────────────

/**
 * Create the tool that kills a terminal session.
 *
 * @param state In-memory plugin state.
 * @param client Paseo transport client.
 * @param logger Logger used for invocation tracing.
 * @returns The OpenCode tool definition.
 */
export function createTerminalKillTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Kill a running Paseo terminal session. Destructive: capture any important output " +
      "with paseo_terminal_capture before killing, because terminal buffers may not remain available afterward.",
    args: {
      terminalId: tool.schema.string().describe("ID of the terminal to kill"),
    },
    async execute(args) {
      logger.info("Tool: paseo_terminal_kill invoked", { terminalId: args.terminalId })

      const result = await client.killTerminal(args.terminalId)

      // Update state and clean up session bindings
      const terminal = state.terminals.get(args.terminalId)
      if (terminal) {
        terminal.status = "killed"
      }
      unbindTerminalFromSessions(state, args.terminalId)

      return {
        title: "Terminal Killed",
        output: JSON.stringify(
          {
            id: result.id,
            exitCode: result.exitCode,
            status: "killed",
          },
          null,
          2,
        ),
      }
    },
  })
}
