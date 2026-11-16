/**
 * `defineTool`: declares a tool as a frozen description with its `execute` handler.
 */
import type { ToolDescription } from '#/llm/message';

import type { ToolExecuteInput, ToolResult } from './executor';

export interface ToolDefinition extends ToolDescription {
  execute(input: ToolExecuteInput): Promise<ToolResult>;
}

export function defineTool(tool: ToolDefinition): ToolDefinition {
  if (tool.name.trim() === '') {
    throw new Error('tool name must not be empty');
  }
  return Object.freeze(tool);
}
