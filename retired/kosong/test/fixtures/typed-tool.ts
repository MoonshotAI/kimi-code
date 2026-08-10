import { z } from 'zod';

import type { Tool } from '#/tool';
import { compileArgsValidator, type JsonValue } from './args-validator';
import { toolValidateError, type ToolReturnValue } from './simple-toolset';

/**
 * Configuration for a typed tool.
 */
export interface TypedToolConfig<TParams> {
  /** Unique tool name used to match invocations. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** Zod schema describing the parameter shape. The JSON Schema fed to the
   * model is generated from this schema, and incoming arguments are validated
   * against it at runtime. */
  params: z.ZodType<TParams>;
  /** Handler invoked with parsed, type-checked parameters. */
  handler: (params: TParams) => Promise<ToolReturnValue>;
}

export interface TypedTool {
  tool: Tool;
  handler: (args: JsonValue) => Promise<ToolReturnValue>;
}

export function createTypedTool<TParams>(config: TypedToolConfig<TParams>): TypedTool {
  const runtimeSchema =
    config.params instanceof z.ZodObject
      ? (config.params.strict() as z.ZodType<TParams>)
      : config.params;

  const jsonSchema = z.toJSONSchema(runtimeSchema) as Record<string, unknown>;
  delete jsonSchema['$schema'];

  const tool: Tool = {
    name: config.name,
    description: config.description,
    parameters: jsonSchema,
  };

  // Belt-and-braces meta-schema check at construction time.
  try {
    compileArgsValidator(tool.parameters);
  } catch (error) {
    throw new Error(
      `Invalid parameters schema for tool '${tool.name}': ${(error as Error).message}`, { cause: error },
    );
  }

  const handler = async (args: JsonValue): Promise<ToolReturnValue> => {
    const result = runtimeSchema.safeParse(args);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => {
          const path = issue.path.join('.');
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join('; ');
      return toolValidateError(`Tool parameter validation failed: ${issues}`);
    }
    return config.handler(result.data);
  };

  return { tool, handler };
}
