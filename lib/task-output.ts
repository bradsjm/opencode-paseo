/** Supported lifecycle states for rendered task output. */
export type TaskOutputState = "running" | "completed" | "error"

/**
 * Renders task output as a task wrapper with a state-specific payload element.
 *
 * @param input - Task metadata and rendered content to embed in the output wrapper.
 * @param input.sessionID
 * @param input.state
 * @param input.summary
 * @param input.text
 * @returns A task XML fragment containing the state, optional summary, and task text.
 */
export function renderTaskOutput(input: {
  sessionID: string
  state: TaskOutputState
  summary?: string
  text: string
}): string {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}
