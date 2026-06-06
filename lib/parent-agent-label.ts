export const PASEO_PARENT_AGENT_LABEL = "paseo.parent-agent-id"

export function getPaseoParentAgentIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const parentAgentId = env.PASEO_AGENT_ID?.trim()
  return parentAgentId ? parentAgentId : undefined
}

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
