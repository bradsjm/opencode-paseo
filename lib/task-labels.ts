/** Label key that stores the task session ID on a worker. */
export const TASK_SESSION_LABEL = "opencodePaseo.taskSessionId"

/** Label key that stores the parent session ID for a task worker. */
export const TASK_PARENT_SESSION_LABEL = "opencodePaseo.parentSessionId"

/** Label key that stores the task description on a worker. */
export const TASK_DESCRIPTION_LABEL = "opencodePaseo.taskDescription"

/** Label key that stores the subagent type used for a task worker. */
export const TASK_SUBAGENT_LABEL = "opencodePaseo.taskSubagentType"

/** Label key that marks a task worker as deferred. */
export const TASK_DEFERRED_LABEL = "opencodePaseo.taskDeferred"

/** Label key that marks a task worker as already having its completion injected. */
export const TASK_COMPLETION_INJECTED_LABEL = "opencodePaseo.taskCompletionInjected"

/** Normalized task metadata recovered from worker labels. */
export interface TaskLabelInfo {
  taskSessionId: string
  parentSessionId: string
  description?: string
  subagentType?: string
  deferred?: boolean
  completionInjected?: boolean
}

/**
 * Builds the label set used to mark a worker as a task run.
 *
 * @param input - Normalized task metadata to encode into labels.
 * @returns A label map containing the task session and parent session identifiers, plus optional metadata labels.
 */
export function taskRunLabels(input: TaskLabelInfo): Record<string, string> {
  return {
    [TASK_SESSION_LABEL]: input.taskSessionId,
    [TASK_PARENT_SESSION_LABEL]: input.parentSessionId,
    ...(input.description ? { [TASK_DESCRIPTION_LABEL]: input.description } : {}),
    ...(input.subagentType ? { [TASK_SUBAGENT_LABEL]: input.subagentType } : {}),
  }
}

/**
 * Extracts task metadata from a worker's label map when the required labels are present.
 *
 * @param labels - Worker labels to inspect.
 * @returns The parsed task metadata, or `null` when the required task labels are missing.
 */
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
