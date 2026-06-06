import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin/tool"
import type { PluginState } from "../state/types.js"
import type { PaseoTransport } from "../transport/types.js"
import type { Logger } from "../logger.js"
import { getOrCreateSession, recordCreatedTerminal, unbindTerminalFromSessions } from "../state/state.js"

// ─── Terminal List Tool ──────────────────────────────────────────────────────

export function createTerminalListTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "List daemon-reported Paseo terminals. By default lists terminals for the current working directory; " +
      "set all to true to request the daemon's unfiltered terminal list.",
    args: {
      cwd: tool.schema.string().optional().describe("Filter terminals by working directory"),
      all: tool.schema.boolean().optional().describe("List all daemon-reported terminals without a cwd filter"),
    },
    async execute(args, context: ToolContext) {
      const cwd = args.all ? undefined : (args.cwd ?? context.directory)
      logger.info("Tool: paseo_terminal_list invoked", { cwd, all: args.all })

      const terminals = await client.listTerminals(cwd)

      return {
        title: "Paseo Terminals",
        output: JSON.stringify({ terminals, count: terminals.length }, null, 2),
      }
    },
  })
}

// ─── Terminal Create Tool ────────────────────────────────────────────────────

export function createTerminalCreateTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description: "Create a new Paseo terminal session. The terminal is bound to the current opencode session.",
    args: {
      cwd: tool.schema
        .string()
        .optional()
        .describe("Working directory for the terminal (defaults to session directory)"),
      name: tool.schema.string().optional().describe("Human-readable name for the terminal"),
      agentId: tool.schema.string().optional().describe("Associate terminal with a specific agent"),
    },
    async execute(args, context: ToolContext) {
      const cwd = args.cwd ?? context.directory
      logger.info("Tool: paseo_terminal_create invoked", { cwd, name: args.name })

      const result = await client.createTerminal({
        cwd,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
      })

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
    },
  })
}

// ─── Terminal Capture Tool ───────────────────────────────────────────────────

export function createTerminalCaptureTool(state: PluginState, client: PaseoTransport, logger: Logger): ToolDefinition {
  return tool({
    description:
      "Capture output from a Paseo terminal. Returns daemon-native lines and totalLines metadata. " +
      "Use scrollback to request capture from the start of the daemon buffer.",
    args: {
      terminalId: tool.schema.string().describe("ID of the terminal to capture"),
      start: tool.schema.number().int().optional().describe("Start line/range passed to the daemon capture API"),
      end: tool.schema.number().int().optional().describe("End line/range passed to the daemon capture API"),
      scrollback: tool.schema.boolean().optional().describe("Capture from daemon scrollback by setting start to 0"),
      stripAnsi: tool.schema.boolean().optional().describe("Strip ANSI escape codes from output (default: true)"),
    },
    async execute(args) {
      logger.info("Tool: paseo_terminal_capture invoked", {
        terminalId: args.terminalId,
        start: args.start,
        end: args.end,
        scrollback: args.scrollback,
      })

      const capture = await client.captureTerminal({
        terminalId: args.terminalId,
        stripAnsi: args.stripAnsi ?? true,
        ...(args.scrollback ? { start: 0 } : args.start !== undefined ? { start: args.start } : {}),
        ...(args.end !== undefined ? { end: args.end } : {}),
      })

      return {
        title: `Terminal Capture: ${args.terminalId}`,
        output: JSON.stringify(capture, null, 2),
      }
    },
  })
}

// ─── Terminal Send Input Tool ────────────────────────────────────────────────

export function createTerminalSendInputTool(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
): ToolDefinition {
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

export function createTerminalSendLinesTool(
  state: PluginState,
  client: PaseoTransport,
  logger: Logger,
): ToolDefinition {
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
