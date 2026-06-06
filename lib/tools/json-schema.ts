import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import { tool } from "@opencode-ai/plugin/tool"

export type JsonSchema = Record<string, unknown>

type ZodSchemaNamespace = typeof tool.schema & {
  toJSONSchema?: (schema: unknown, params?: { io?: "input" | "output" }) => JsonSchema
}

export function createToolArgsJsonSchema(args: ToolDefinition["args"]): JsonSchema {
  const schema = tool.schema as ZodSchemaNamespace
  if (typeof schema.toJSONSchema !== "function") {
    throw new Error("tool.schema.toJSONSchema is not available in the current @opencode-ai/plugin runtime")
  }

  const jsonSchema = schema.toJSONSchema(tool.schema.object(args), { io: "input" })
  const { $schema: _schema, ...normalizedSchema } = jsonSchema
  return normalizedSchema
}
