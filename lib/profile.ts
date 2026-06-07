// ─── Profile Resolution Layer ────────────────────────────────────────────────
// Maps OpenCode agent definitions ("profiles") into a minimal internal shape
// used by the profile-list tool and the worker-create tool.

import type { Agent, createOpencodeClient } from "@opencode-ai/sdk"

// ─── Types ───────────────────────────────────────────────────────────────────

/** OpenCode client type used by the plugin. */
export type OpencodeClient = ReturnType<typeof createOpencodeClient>

type AgentLike = Pick<Agent, "name"> & Partial<Agent>
type PermissionValue = "ask" | "allow" | "deny"

const DEFAULT_MODEL_LABEL = "inherits OpenCode default at launch"

/** Minimal profile shape used inside the plugin. */
export interface ProfileSummary {
  name: string
  description: string | null
  mode: string
  providerID: string | null
  modelID: string | null
  permission: Agent["permission"] | null
  prompt: string | null
}

/** Default profile name when none is explicitly provided. */
export const DEFAULT_PROFILE = "build"

// ─── Mapping ─────────────────────────────────────────────────────────────────

/**
 * Map a raw OpenCode agent into the plugin's `ProfileSummary` shape.
 *
 * @param agent Raw agent data from the OpenCode SDK.
 * @returns The normalized profile summary.
 */
export function mapAgentToProfile(agent: AgentLike): ProfileSummary {
  const model = agent.model
  return {
    name: agent.name ?? "",
    description: agent.description ?? null,
    mode: agent.mode ?? "all",
    providerID: model?.providerID ?? null,
    modelID: model?.modelID ?? null,
    permission: agent.permission ?? null,
    prompt: agent.prompt ?? null,
  }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Fetch available OpenCode profiles for a directory.
 *
 * @param client OpenCode client used to query profiles.
 * @param directory Directory to resolve profiles for.
 * @returns A promise that resolves to the available profile summaries.
 */
export async function listProfiles(client: OpencodeClient, directory: string): Promise<ProfileSummary[]> {
  const result = await client.app.agents({ query: { directory } })
  const agents = result.data ?? []
  return agents.map(mapAgentToProfile)
}

function normalizePermissionValue(value: unknown): PermissionValue {
  return value === "allow" || value === "deny" || value === "ask" ? value : "ask"
}

function summarizeBashPermission(
  bash: Agent["permission"]["bash"] | Record<string, unknown> | null | undefined,
): PermissionValue | "mixed" {
  if (!bash || typeof bash !== "object" || Array.isArray(bash)) return "mixed"

  const values = Object.values(bash)
    .filter((value): value is unknown => value !== undefined)
    .map(normalizePermissionValue)

  const firstValue = values[0]
  if (firstValue === undefined) return "mixed"

  return values.every((value) => value === firstValue) ? firstValue : "mixed"
}

/**
 * Format the provider/model label for a profile.
 *
 * @param profile Profile data containing provider and model identifiers.
 * @returns The formatted provider/model label, or the default label when either part is missing.
 */
export function formatProfileModelLabel(profile: Pick<ProfileSummary, "providerID" | "modelID">): string {
  const providerID = profile.providerID?.trim()
  const modelID = profile.modelID?.trim()
  return providerID && modelID ? `${providerID}/${modelID}` : DEFAULT_MODEL_LABEL
}

/**
 * Summarize a profile's permission settings.
 *
 * @param profile Profile data containing permission settings.
 * @returns A compact human-readable permission summary.
 */
export function summarizeProfilePermissions(profile: Pick<ProfileSummary, "permission">): string {
  const edit = normalizePermissionValue(profile.permission?.edit)
  const bash = summarizeBashPermission(profile.permission?.bash)

  if (edit === "allow" && bash === "allow") return "full access"
  if (edit === "deny" && bash === "deny") return "no edits or bash"

  return `edit ${edit}, bash ${bash}`
}

/**
 * Normalize a profile name.
 *
 * @param name Profile name to normalize.
 * @returns The trimmed name, or the default profile name when the input is empty.
 */
export function normalizeProfileName(name: string | undefined | null): string {
  if (!name || name.trim().length === 0) return DEFAULT_PROFILE
  return name.trim()
}

/**
 * Resolve a profile by name from a pre-fetched profile list.
 *
 * @param profiles Profiles to search.
 * @param name Profile name to resolve.
 * @returns The matching profile.
 * @throws Error If no profile with the requested name exists.
 */
export function resolveProfile(profiles: ProfileSummary[], name: string): ProfileSummary {
  const match = profiles.find((p) => p.name === name)
  if (!match) {
    const available = profiles.map((p) => p.name).join(", ")
    throw new Error(`Profile "${name}" not found. Available profiles: ${available || "(none)"}`)
  }
  return match
}

/**
 * Translate a resolved profile into daemon worker-create fields.
 *
 * @param profile Resolved profile to convert.
 * @returns The provider, model, and mode fields used for worker creation.
 */
export function profileToWorkerFields(profile: ProfileSummary): {
  provider: string
  model?: string
  modeId: string
} {
  const providerID = profile.providerID?.trim()
  const modelID = profile.modelID?.trim()
  const hasFullModel = Boolean(providerID && modelID)

  return {
    // OpenCode profile model metadata identifies the routed model, while Paseo
    // worker creation uses the OpenCode runtime provider plus a provider/model
    // model string.
    modeId: profile.name,
    provider: "opencode",
    ...(hasFullModel ? { model: `${providerID}/${modelID}` } : {}),
  }
}
