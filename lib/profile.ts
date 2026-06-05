// ─── Profile Resolution Layer ────────────────────────────────────────────────
// Maps OpenCode agent definitions ("profiles") into a minimal internal shape
// used by the profile-list tool and the worker-create tool.

import type { Agent, createOpencodeClient } from "@opencode-ai/sdk"

// ─── Types ───────────────────────────────────────────────────────────────────

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
 * Map a raw OpenCode Agent object into the plugin's ProfileSummary shape.
 * Accepts the raw object to avoid tight coupling to a specific SDK version.
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
 * Fetch available OpenCode profiles for the given directory.
 * Returns an array of ProfileSummary objects.
 */
export async function listProfiles(client: OpencodeClient, directory: string): Promise<ProfileSummary[]> {
  const result = await client.app.agents({ query: { directory } })
  const agents = (result.data ?? []) as Agent[]
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

export function formatProfileModelLabel(profile: Pick<ProfileSummary, "providerID" | "modelID">): string {
  const providerID = profile.providerID?.trim()
  const modelID = profile.modelID?.trim()
  return providerID && modelID ? `${providerID}/${modelID}` : DEFAULT_MODEL_LABEL
}

export function summarizeProfilePermissions(profile: Pick<ProfileSummary, "permission">): string {
  const edit = normalizePermissionValue(profile.permission?.edit)
  const bash = summarizeBashPermission(profile.permission?.bash)

  if (edit === "allow" && bash === "allow") return "full access"
  if (edit === "deny" && bash === "deny") return "no edits or bash"

  return `edit ${edit}, bash ${bash}`
}

/**
 * Normalize a profile name input: empty/whitespace strings become the default.
 */
export function normalizeProfileName(name: string | undefined | null): string {
  if (!name || name.trim().length === 0) return DEFAULT_PROFILE
  return name.trim()
}

/**
 * Resolve a profile by name from a pre-fetched profile list.
 * Throws a clear error listing available profiles if not found.
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
 * Translate a resolved profile into the daemon worker-create fields.
 * Returns an object suitable for merging into CreateWorkerOptions.
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
