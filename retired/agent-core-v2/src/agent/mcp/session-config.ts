import type { McpServerConfig } from './config-schema';

import { loadMcpServersWithSources, type McpConfigSource, type SourcedMcpServerConfig } from './config-loader';

export interface SessionMcpConfig {
  readonly servers: Record<string, McpServerConfig>;
  /** Per-server origin; ``undefined`` for caller-supplied / plugin servers. */
  readonly sources?: Record<string, McpConfigSource>;
}

export interface ResolveSessionMcpConfigInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export async function resolveSessionMcpConfig(
  input: ResolveSessionMcpConfigInput,
): Promise<SessionMcpConfig | undefined> {
  const sourced = await loadMcpServersWithSources({
    cwd: input.cwd,
    homeDir: input.homeDir,
  });
  if (Object.keys(sourced).length === 0) return undefined;
  const servers: Record<string, McpServerConfig> = {};
  const sources: Record<string, McpConfigSource> = {};
  for (const [name, entry] of Object.entries(sourced)) {
    servers[name] = entry.config;
    sources[name] = entry.source;
  }
  return { servers, sources };
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
    sources: base?.sources,
  };
}

export type { McpConfigSource, SourcedMcpServerConfig };