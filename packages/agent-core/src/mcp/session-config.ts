import type { McpServerConfig } from '#/config/schema';

import { loadMcpServers } from './config-loader';

export interface SessionMcpConfig {
  readonly servers: Record<string, McpServerConfig>;
}

export interface ResolveSessionMcpConfigInput {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly trustProjectMcpConfig?: boolean;
}

export async function resolveSessionMcpConfig(
  input: ResolveSessionMcpConfigInput,
): Promise<SessionMcpConfig | undefined> {
  const servers = await loadMcpServers({
    cwd: input.cwd,
    homeDir: input.homeDir,
    trustProjectMcpConfig: input.trustProjectMcpConfig,
  });
  if (Object.keys(servers).length === 0) return undefined;
  return { servers };
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
  };
}
