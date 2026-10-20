import type { McpServerSource } from '#/features/mcp/config/sources';
import type { McpServerConfig } from '#/features/mcp/core/config-schema';

export interface PluginMcpSourceDeps {
  readonly servers: () => Promise<Record<string, McpServerConfig>>;
  readonly onDidChange: (listener: () => void) => () => void;
}

export function createPluginMcpSource(deps: PluginMcpSourceDeps): McpServerSource {
  return {
    id: 'plugin',
    load: () => deps.servers(),
    onDidChange: deps.onDidChange,
  };
}
