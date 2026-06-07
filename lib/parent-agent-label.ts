/** Label key that stores the parent agent ID on a worker. */
export const PASEO_PARENT_AGENT_LABEL = "paseo.parent-agent-id"

/**
 * Reads the parent agent ID from the current process environment.
 *
 * @param env - Environment object to read from, defaulting to the current process environment.
 * @returns The trimmed parent agent ID, or `undefined` when the variable is missing or blank.
 */
export function getPaseoParentAgentIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const parentAgentId = env.PASEO_AGENT_ID?.trim()
  return parentAgentId ? parentAgentId : undefined
}

/**
 * Merges the Paseo parent agent label into an existing label map.
 *
 * @param labels - Existing worker labels to sanitize and merge.
 * @param env - Environment object to read from, defaulting to the current process environment.
 * @returns The merged label map, or `undefined` when there are no labels and no parent agent ID.
 */
export function mergePaseoParentAgentLabel(
  labels?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const parentAgentId = getPaseoParentAgentIdFromEnv(env)
  const sanitizedLabels = labels
    ? Object.fromEntries(Object.entries(labels).filter(([key]) => key !== PASEO_PARENT_AGENT_LABEL))
    : undefined

  if (!sanitizedLabels && !parentAgentId) {
    return undefined
  }

  return parentAgentId
    ? {
        ...(sanitizedLabels ?? {}),
        [PASEO_PARENT_AGENT_LABEL]: parentAgentId,
      }
    : { ...(sanitizedLabels ?? {}) }
}
