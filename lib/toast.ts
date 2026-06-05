import type { PluginInput } from "@opencode-ai/plugin"

interface WarningToastOptions {
  title: string
  message: string
  delayMs?: number
}

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
