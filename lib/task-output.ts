export type TaskOutputState = "running" | "completed" | "error"

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
