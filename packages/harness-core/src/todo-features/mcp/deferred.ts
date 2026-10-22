import type { ToolDescription } from '@moonshot-ai/agent-core/llm/message';
import type { Loop } from '@moonshot-ai/agent-core/loop/index';

export const MCP_DYNAMIC_TOOLS_REMIND_KEY = 'mcp-dynamic-tools';

export interface McpDynamicToolEntry {
  readonly serverName: string;
  readonly description: ToolDescription;
}

export interface McpDeferredChannel {
  sync(entries: readonly McpDynamicToolEntry[]): void;
}

export function renderMcpDynamicToolsText(entries: readonly McpDynamicToolEntry[]): string {
  if (entries.length === 0) {
    return (
      'All dynamically provided MCP tools have been withdrawn; do not call them. ' +
      'This notice replaces any earlier MCP dynamic tool lists in this conversation.'
    );
  }
  const lines = entries.map(
    (entry) => `- ${entry.description.name} (MCP server "${entry.serverName}")`,
  );
  return [
    'The following MCP tools are available but are not in your static tool list ' +
      '(their servers are deferred or connected after the session started). ' +
      'Their schemas are attached to this message; call them by exact name.',
    ...lines,
    'This list replaces any earlier MCP dynamic tool lists in this conversation.',
  ].join('\n');
}

export function createMcpDeferredChannel(loop: Pick<Loop, 'remind'>): McpDeferredChannel {
  let lastPushed: string | undefined;
  return {
    sync(entries) {
      const signature = entries
        .map((entry) => entry.description.name)
        .toSorted((a, b) => a.localeCompare(b))
        .join('\n');
      if (signature === lastPushed) return;
      if (entries.length === 0 && lastPushed === undefined) return;
      const ack = loop.remind({
        message: {
          role: 'system',
          content: [{ type: 'text', text: renderMcpDynamicToolsText(entries) }],
          tools: entries.length > 0 ? entries.map((entry) => entry.description) : undefined,
        },
        meta: { source: 'reminder', key: MCP_DYNAMIC_TOOLS_REMIND_KEY },
      });
      if (ack !== undefined) lastPushed = signature;
    },
  };
}
