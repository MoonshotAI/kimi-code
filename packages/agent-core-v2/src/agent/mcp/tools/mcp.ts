/**
 * MCP tool adapter — wraps a remote MCP tool as an `ExecutableTool`.
 *
 * Each tool exposed by a connected MCP server is adapted into an
 * `ExecutableTool` whose `resolveExecution` forwards the call to the client
 * and normalizes the result.
 */

import type { Tool as KosongTool } from '#/app/llmProtocol';

import type { ExecutableTool, ExecutableToolResult } from '#/agent/tool';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import type { MCPClient } from '#/agent/mcp/types';

export function createMcpTool(
  qualifiedName: string,
  tool: KosongTool,
  client: MCPClient,
  options: { readonly originalsDir?: string } = {},
): ExecutableTool {
  return {
    name: qualifiedName,
    description: tool.description,
    parameters: tool.parameters,
    resolveExecution: (args) => ({
      approvalRule: qualifiedName,
      execute: async (context) => {
        const result = await client.callTool(
          tool.name,
          (args ?? {}) as Record<string, unknown>,
          context.signal,
        );
        return normalizeMcpToolResult(
          await mcpResultToExecutableOutput(result, qualifiedName, {
            originalsDir: options.originalsDir,
          }),
        );
      },
    }),
  };
}

function normalizeMcpToolResult(result: {
  readonly output: ExecutableToolResult['output'];
  readonly isError: boolean;
  readonly truncated?: true;
}): ExecutableToolResult {
  if (result.isError) {
    return result.truncated === true
      ? { output: result.output, isError: true, truncated: true }
      : { output: result.output, isError: true };
  }
  return result.truncated === true
    ? { output: result.output, truncated: true }
    : { output: result.output };
}
