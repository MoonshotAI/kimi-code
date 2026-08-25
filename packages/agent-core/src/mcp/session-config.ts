import type { McpServerConfig } from '#/config/schema';

import { loadMcpServers } from './config-loader';
import type { McpServerSource } from './registry';

export interface SessionMcpConfig {
  readonly servers: Record<string, McpServerConfig>;
  /**
   * Per-server origin tag, aligned with the unified registry's sources
   * (`global` layered files / `plugin` manifest / `caller` SDK injection).
   * The connection manager records it per entry so management operations can
   * tell read-only plugin entries from mutable global ones.
   */
  readonly sources?: Record<string, McpServerSource>;
}

export interface ResolveSessionMcpConfigInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export async function resolveSessionMcpConfig(
  input: ResolveSessionMcpConfigInput,
): Promise<SessionMcpConfig | undefined> {
  const servers = await loadMcpServers({
    cwd: input.cwd,
    homeDir: input.homeDir,
  });
  if (Object.keys(servers).length === 0) return undefined;
  return {
    servers,
    sources: Object.fromEntries(Object.keys(servers).map((name) => [name, 'global'])),
  };
}

export function mergeCallerMcpServers(
  base: SessionMcpConfig | undefined,
  callerServers: Readonly<Record<string, McpServerConfig>> | undefined,
): SessionMcpConfig | undefined {
  if (callerServers === undefined || Object.keys(callerServers).length === 0) {
    return base;
  }
  return {
    servers: {
      ...base?.servers,
      ...callerServers,
    },
    sources: {
      ...base?.sources,
      ...Object.fromEntries(Object.keys(callerServers).map((name) => [name, 'caller'])),
    },
  };
}
