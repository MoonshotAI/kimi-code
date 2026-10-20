import type { ToolDefinition, ToolExecuteInput, ToolResult, ToolSchema, TypedToolInput } from './contract';
import { toolError } from './policy';

export interface DefineToolSpec<Args> {
  readonly name: string;
  readonly description: string;
  readonly schema: ToolSchema<Args>;
  readonly deferred?: true;
  execute(input: TypedToolInput<Args>): Promise<ToolResult>;
}

function parseArguments(raw: string | null): { ok: true; value: unknown } | { ok: false } {
  if (raw === null || raw === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

export function defineTool<Args>(spec: DefineToolSpec<Args>): ToolDefinition {
  const execute = async (input: ToolExecuteInput) => {
    const parsed = parseArguments(input.toolCall.arguments);
    if (!parsed.ok) return toolError('invalid arguments: malformed JSON');
    const args = spec.schema.parse(parsed.value);
    if (args === undefined) return toolError('invalid arguments');
    return spec.execute({ ...input, args });
  };
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.schema.jsonSchema,
    ...(spec.deferred === true ? { deferred: true as const } : {}),
    execute,
  };
}
