import type { PluginInput } from "@opencode-ai/plugin"

interface WarningToastOptions {
  title: string
  message: string
  delayMs?: number
}

/**
 * Queues a warning toast for the current OpenCode session.
 *
 * @param ctx - OpenCode plugin context that provides access to the TUI toast API.
 * @param options - Toast title, message, and optional delay before display.
 * @returns Nothing.
 */
export function queueWarningToast(ctx: PluginInput, options: WarningToastOptions): void {
  const { title, message, delayMs = 0 } = options

  setTimeout(() => {
    try {
      void ctx.client?.tui?.showToast?.({
        body: {
          title,
          message,
          variant: "warning",
          duration: 7000,
        },
      })
    } catch {
      return
    }
  }, delayMs)
}

/**
 * Creates a one-shot notifier that shows at most one startup warning toast.
 *
 * @param ctx - OpenCode plugin context that provides access to the TUI toast API.
 * @returns A callback that queues the first warning and ignores later calls.
 */
export function createStartupWarningNotifier(ctx: PluginInput): (title: string, message: string) => void {
  let warned = false

  return (title, message) => {
    if (warned) {
      return
    }

    warned = true
    queueWarningToast(ctx, { title, message })
  }
}
