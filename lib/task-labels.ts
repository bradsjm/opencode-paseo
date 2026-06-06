export const TASK_SESSION_LABEL = "opencodePaseo.taskSessionId"
export const TASK_PARENT_SESSION_LABEL = "opencodePaseo.parentSessionId"
export const TASK_DESCRIPTION_LABEL = "opencodePaseo.taskDescription"
export const TASK_SUBAGENT_LABEL = "opencodePaseo.taskSubagentType"
export const TASK_DEFERRED_LABEL = "opencodePaseo.taskDeferred"
export const TASK_COMPLETION_INJECTED_LABEL = "opencodePaseo.taskCompletionInjected"

export interface TaskLabelInfo {
  taskSessionId: string
  parentSessionId: string
  description?: string
  subagentType?: string
  deferred?: boolean
  completionInjected?: boolean
}

export function taskRunLabels(input: TaskLabelInfo): Record<string, string> {
  return {
    [TASK_SESSION_LABEL]: input.taskSessionId,
    [TASK_PARENT_SESSION_LABEL]: input.parentSessionId,
    ...(input.description ? { [TASK_DESCRIPTION_LABEL]: input.description } : {}),
    ...(input.subagentType ? { [TASK_SUBAGENT_LABEL]: input.subagentType } : {}),
  }
}

export function getTaskLabelInfo(labels: Record<string, string> | undefined): TaskLabelInfo | null {
  const taskSessionId = taskLabelValue(labels, TASK_SESSION_LABEL)
  const parentSessionId = taskLabelValue(labels, TASK_PARENT_SESSION_LABEL)
  if (!taskSessionId || !parentSessionId) return null
  return {
    taskSessionId,
    parentSessionId,
    ...optionalTaskLabel("description", taskLabelValue(labels, TASK_DESCRIPTION_LABEL)),
    ...optionalTaskLabel("subagentType", taskLabelValue(labels, TASK_SUBAGENT_LABEL)),
    ...(labels?.[TASK_DEFERRED_LABEL] === "true" ? { deferred: true } : {}),
    ...(labels?.[TASK_COMPLETION_INJECTED_LABEL] === "true" ? { completionInjected: true } : {}),
  }
}

function taskLabelValue(labels: Record<string, string> | undefined, key: string): string | undefined {
  const value = labels?.[key]?.trim()
  return value ? value : undefined
}

function optionalTaskLabel<K extends "description" | "subagentType">(key: K, value: string | undefined) {
  return value ? { [key]: value } : {}
}
