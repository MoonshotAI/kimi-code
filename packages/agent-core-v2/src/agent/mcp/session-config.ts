import type { McpServerConfig } from './config-schema';

import { loadMcpServers } from './config-loader';

export interface SessionMcpConfig {
  readonly servers: Record<string, McpServerConfig>;
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
  return { servers };
}
