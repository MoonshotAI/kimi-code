import type { Unsubscribe } from '@moonshot-ai/agent-core/kernel/index';

import type { McpServerSource } from '#/features/mcp/config/sources';
import type { McpServerConfig } from '#/features/mcp/core/config-schema';

export interface PluginMcpSourceDeps {
  readonly servers: () => Promise<Record<string, McpServerConfig>>;
  readonly onDidChange: (listener: () => void) => Unsubscribe;
}

export function createPluginMcpSource(deps: PluginMcpSourceDeps): McpServerSource {
  return {
    id: 'plugin',
    load: () => deps.servers(),
    onDidChange: deps.onDidChange,
  };
}
