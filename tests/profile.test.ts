import test from "node:test"
import assert from "node:assert/strict"
import {
    mapAgentToProfile,
    normalizeProfileName,
    resolveProfile,
    profileToWorkerFields,
    DEFAULT_PROFILE,
    type ProfileSummary,
} from "../lib/profile.js"

// ─── normalizeProfileName ────────────────────────────────────────────────────

test("normalizeProfileName", async (t) => {
    await t.test("returns default for undefined", () => {
        assert.equal(normalizeProfileName(undefined), DEFAULT_PROFILE)
    })

    await t.test("returns default for null", () => {
        assert.equal(normalizeProfileName(null), DEFAULT_PROFILE)
    })

    await t.test("returns default for empty string", () => {
        assert.equal(normalizeProfileName(""), DEFAULT_PROFILE)
    })

    await t.test("returns default for whitespace-only string", () => {
        assert.equal(normalizeProfileName("   "), DEFAULT_PROFILE)
    })

    await t.test("trims and returns provided name", () => {
        assert.equal(normalizeProfileName("  build  "), "build")
    })

    await t.test("returns name as-is when clean", () => {
        assert.equal(normalizeProfileName("custom-agent"), "custom-agent")
    })
})

// ─── mapAgentToProfile ───────────────────────────────────────────────────────

test("mapAgentToProfile", async (t) => {
    await t.test("maps full agent to profile summary", () => {
        const result = mapAgentToProfile({
            name: "build",
            description: "Build agent",
            mode: "primary",
            model: { providerID: "openai", modelID: "gpt-5.4" },
            prompt: "You are a build agent",
        })
        assert.equal(result.name, "build")
        assert.equal(result.description, "Build agent")
        assert.equal(result.mode, "primary")
        assert.equal(result.providerID, "openai")
        assert.equal(result.modelID, "gpt-5.4")
        assert.equal(result.prompt, "You are a build agent")
    })

    await t.test("handles missing model", () => {
        const result = mapAgentToProfile({
            name: "minimal",
            mode: "all",
        })
        assert.equal(result.name, "minimal")
        assert.equal(result.providerID, null)
        assert.equal(result.modelID, null)
        assert.equal(result.description, null)
        assert.equal(result.prompt, null)
    })

    await t.test("handles missing optional fields", () => {
        const result = mapAgentToProfile({ name: "bare" })
        assert.equal(result.name, "bare")
        assert.equal(result.mode, "all")
        assert.equal(result.description, null)
        assert.equal(result.providerID, null)
        assert.equal(result.modelID, null)
        assert.equal(result.prompt, null)
    })
})

// ─── resolveProfile ──────────────────────────────────────────────────────────

test("resolveProfile", async (t) => {
    const profiles: ProfileSummary[] = [
        {
            name: "build",
            description: "Build agent",
            mode: "primary",
            providerID: "openai",
            modelID: "gpt-5.4",
            prompt: null,
        },
        {
            name: "review",
            description: "Code reviewer",
            mode: "subagent",
            providerID: "anthropic",
            modelID: "claude-3",
            prompt: null,
        },
    ]

    await t.test("finds existing profile by name", () => {
        const result = resolveProfile(profiles, "build")
        assert.equal(result.name, "build")
        assert.equal(result.providerID, "openai")
    })

    await t.test("finds second profile", () => {
        const result = resolveProfile(profiles, "review")
        assert.equal(result.name, "review")
    })

    await t.test("throws with clear error for unknown profile", () => {
        assert.throws(
            () => resolveProfile(profiles, "nonexistent"),
            /Profile "nonexistent" not found\. Available profiles: build, review/,
        )
    })

    await t.test("throws with (none) for empty profile list", () => {
        assert.throws(() => resolveProfile([], "build"), /Available profiles: \(none\)/)
    })
})

// ─── profileToWorkerFields ───────────────────────────────────────────────────

test("profileToWorkerFields", async (t) => {
    await t.test("maps profile name to opencode provider and joined model string", () => {
        const result = profileToWorkerFields({
            name: "build",
            description: "Build agent",
            mode: "primary",
            providerID: "openai",
            modelID: "gpt-5.4",
            prompt: null,
        })
        assert.equal(result.modeId, "build")
        assert.equal(result.provider, "opencode")
        assert.equal(result.model, "openai/gpt-5.4")
    })

    await t.test("omits model when providerID is missing", () => {
        const result = profileToWorkerFields({
            name: "custom",
            description: null,
            mode: "all",
            providerID: null,
            modelID: "some-model",
            prompt: null,
        })
        assert.equal(result.modeId, "custom")
        assert.equal(result.provider, "opencode")
        assert.equal(result.model, undefined)
    })

    await t.test("omits model when modelID is missing", () => {
        const result = profileToWorkerFields({
            name: "custom",
            description: null,
            mode: "all",
            providerID: "anthropic",
            modelID: null,
            prompt: null,
        })
        assert.equal(result.modeId, "custom")
        assert.equal(result.provider, "opencode")
        assert.equal(result.model, undefined)
    })

    await t.test("keeps opencode provider and omits model when both model parts are null", () => {
        const result = profileToWorkerFields({
            name: "bare",
            description: null,
            mode: "all",
            providerID: null,
            modelID: null,
            prompt: null,
        })
        assert.equal(result.modeId, "bare")
        assert.equal(result.provider, "opencode")
        assert.equal(result.model, undefined)
    })
})
