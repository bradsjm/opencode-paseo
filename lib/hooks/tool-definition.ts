import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import { createToolArgsJsonSchema, type JsonSchema } from "../tools/json-schema.js"
import type { Logger } from "../logger.js"

type ToolDefinitionInput = {
  toolID: string
}

type ToolDefinitionOutput = {
  description: string
  parameters: unknown
  jsonSchema?: JsonSchema
}

export function createToolDefinitionHandler(tools: Record<string, ToolDefinition>, logger?: Logger) {
  return (input: ToolDefinitionInput, output: ToolDefinitionOutput) => {
    if (!input.toolID.startsWith("paseo_")) {
      return Promise.resolve()
    }

    const definition = tools[input.toolID]
    if (!definition) {
      return Promise.resolve()
    }

    try {
      output.jsonSchema = createToolArgsJsonSchema(definition.args)
    } catch (error: unknown) {
      logger?.warn("Failed to generate tool definition JSON Schema", {
        toolID: input.toolID,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return Promise.resolve()
  }
}
