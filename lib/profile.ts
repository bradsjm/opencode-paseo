// ─── Profile Resolution Layer ────────────────────────────────────────────────
// Maps OpenCode agent definitions ("profiles") into a minimal internal shape
// used by the profile-list tool and the worker-create tool.

import type { createOpencodeClient } from "@opencode-ai/sdk"

// ─── Types ───────────────────────────────────────────────────────────────────

export type OpencodeClient = ReturnType<typeof createOpencodeClient>

/** Minimal profile shape used inside the plugin. */
export interface ProfileSummary {
    name: string
    description: string | null
    mode: string
    providerID: string | null
    modelID: string | null
    prompt: string | null
}

/** Default profile name when none is explicitly provided. */
export const DEFAULT_PROFILE = "build"

// ─── Mapping ─────────────────────────────────────────────────────────────────

/**
 * Map a raw OpenCode Agent object into the plugin's ProfileSummary shape.
 * Accepts the raw object to avoid tight coupling to a specific SDK version.
 */
export function mapAgentToProfile(agent: Record<string, unknown>): ProfileSummary {
    const model = agent.model as Record<string, unknown> | undefined
    return {
        name: (agent.name as string) ?? "",
        description: (agent.description as string | null) ?? null,
        mode: (agent.mode as string) ?? "all",
        providerID: (model?.providerID as string | null) ?? null,
        modelID: (model?.modelID as string | null) ?? null,
        prompt: (agent.prompt as string | null) ?? null,
    }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Fetch available OpenCode profiles for the given directory.
 * Returns an array of ProfileSummary objects.
 */
export async function listProfiles(
    client: OpencodeClient,
    directory: string,
): Promise<ProfileSummary[]> {
    const result = await client.app.agents({ query: { directory } })
    const agents = (result.data ?? []) as Array<Record<string, unknown>>
    return agents.map(mapAgentToProfile)
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
