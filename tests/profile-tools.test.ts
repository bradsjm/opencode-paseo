import test from "node:test"
import assert from "node:assert/strict"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { Logger } from "../lib/logger.js"
import { createProfileListTool } from "../lib/tools/profile.js"
import type { OpencodeClient } from "../lib/profile.js"

function mockContext(): ToolContext {
    return {
        sessionID: "sess-1",
        messageID: "msg-1",
        agent: "test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
    }
}

test("paseo_profile_list", async (t) => {
    const logger = new Logger(false)

    await t.test("returns selection-oriented profile fields only", async () => {
        const opencodeClient = {
            app: {
                agents: async () => ({
                    data: [
                        {
                            name: "build",
                            description: "Default build profile",
                            mode: "primary",
                            builtIn: true,
                            permission: {
                                edit: "allow",
                                bash: {
                                    "*": "allow",
                                },
                            },
                            model: { providerID: "openai", modelID: "gpt-5.4" },
                            tools: {},
                            options: {},
                        },
                        {
                            name: "plan",
                            description: "Locked planning profile",
                            mode: "subagent",
                            builtIn: true,
                            permission: {
                                edit: "deny",
                                bash: {
                                    read: "allow",
                                    write: "deny",
                                },
                            },
                            tools: {},
                            options: {},
                        },
                    ],
                }),
            },
        } as OpencodeClient

        const toolDef = createProfileListTool(opencodeClient, logger)
        const result = await toolDef.execute({}, mockContext())
        const output = JSON.parse((result as { output: string }).output)

        assert.deepEqual(Object.keys(output).sort(), ["count", "profiles", "recommendation"])
        assert.equal(output.count, 2)
        assert.equal(
            output.recommendation,
            'Use profile "build" unless a different profile is needed.',
        )
        assert.deepEqual(output.profiles, [
            {
                name: "build",
                description: "Default build profile",
                mode: "primary",
                model: "openai/gpt-5.4",
                permissionSummary: "full access",
            },
            {
                name: "plan",
                description: "Locked planning profile",
                mode: "subagent",
                model: "inherits OpenCode default at launch",
                permissionSummary: "edit deny, bash mixed",
            },
        ])
        assert.equal("defaultProfile" in output, false)
        assert.equal("providerID" in output.profiles[0], false)
        assert.equal("modelID" in output.profiles[0], false)
        assert.equal("isDefault" in output.profiles[0], false)
    })
})
