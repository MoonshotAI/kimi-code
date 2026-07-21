import type { McpServerConfig } from '#/config/schema';

import { loadMcpServersWithDiagnostics } from './config-loader';

export interface SessionMcpConfig {
  readonly servers: Record<string, McpServerConfig>;
  readonly warnings?: readonly string[];
}

export interface ResolveSessionMcpConfigInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export async function resolveSessionMcpConfig(
  input: ResolveSessionMcpConfigInput,
): Promise<SessionMcpConfig | undefined> {
  const result = await loadMcpServersWithDiagnostics({
    cwd: input.cwd,
    homeDir: input.homeDir,
  });
  const servers = result.servers;
  if (Object.keys(servers).length === 0) return undefined;
  return { servers, warnings: result.warnings };
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
    warnings: base?.warnings,
  };
}
