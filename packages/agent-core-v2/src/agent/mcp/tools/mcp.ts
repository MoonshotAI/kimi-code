/**
 * MCP tool adapter — wraps a remote MCP tool as an `ExecutableTool`.
 *
 * Each tool exposed by a connected MCP server is adapted into an
 * `ExecutableTool` whose `resolveExecution` forwards the call to the client
 * and normalizes the result.
 */

import type { Tool as KosongTool } from '#/kosong/contract/tool';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

import type { ExecutableTool, ExecutableToolResult } from '#/tool/toolContract';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import type { MCPClient } from '#/agent/mcp/types';

interface McpToolOptions {
  readonly originalsDir?: string;
  readonly telemetry?: ITelemetryService;
}

export function createMcpTool(
  qualifiedName: string,
  tool: KosongTool,
  client: MCPClient,
  options: McpToolOptions = {},
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
            telemetry: options.telemetry,
          }),
        );
      },
    }),
  };
}

function normalizeMcpToolResult(result: {
  readonly output: ExecutableToolResult['output'];
  readonly isError: boolean;
  readonly note?: string;
  readonly truncated?: true;
}): ExecutableToolResult {
  if (result.isError) {
    return result.truncated === true
      ? { output: result.output, isError: true, note: result.note, truncated: true }
      : { output: result.output, isError: true, note: result.note };
  }
  return result.truncated === true
    ? { output: result.output, note: result.note, truncated: true }
    : { output: result.output, note: result.note };
}
