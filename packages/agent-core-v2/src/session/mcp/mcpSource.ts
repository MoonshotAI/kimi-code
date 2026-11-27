import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { McpConnectionView } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { isMcpServerConfig, type McpServerConfigEntry } from '#/mcpCore/config-override';

export const MCP_SOURCE_PRIORITY = {
  plugin: 0,
  user: 10,
  'project-root': 20,
  workspace: 30,
  runtime: 50,
  caller: 100,
} as const;

export interface McpSource {
  readonly id: string;
  readonly priority: number;
  readonly ready: Promise<void>;
  readonly view: McpConnectionView;
  entries(): Readonly<Record<string, McpServerConfigEntry>>;
  readonly onDidChangeEntries?: Event<void>;
  readonly stdioCwd?: () => string;
  acquire?(ownerId: string, servers: Readonly<Record<string, McpServerConfig>>): Promise<void>;
  release?(ownerId: string): Promise<void>;
  dispose?(): void | Promise<void>;
}

export const ISessionMcpSources: ServiceIdentifier<readonly McpSource[]> =
  createDecorator<readonly McpSource[]>('sessionMcpSources');

export function sessionMcpSourcesSeed(sources: readonly McpSource[]): ScopeSeed {
  return [[ISessionMcpSources as ServiceIdentifier<unknown>, sources]];
}

export const ISessionDisabledMcpSources: ServiceIdentifier<readonly string[]> =
  createDecorator<readonly string[]>('sessionDisabledMcpSources');

export function sessionDisabledMcpSourcesSeed(sourceIds: readonly string[]): ScopeSeed {
  return [[ISessionDisabledMcpSources as ServiceIdentifier<unknown>, sourceIds]];
}

export function arbitrateMcpSources(
  sources: readonly McpSource[],
): Map<string, Record<string, McpServerConfig>> {
  const activeSources = [...sources].toSorted((a, b) => a.priority - b.priority);
  const winnersBySource = new Map<string, Record<string, McpServerConfig>>();
  const vetoed = new Set<string>();
  for (const source of activeSources) {
    for (const [name, entry] of Object.entries(source.entries())) {
      if (!isMcpServerConfig(entry)) {
        if (entry.enabled === false) {
          vetoed.add(name);
          for (const configs of winnersBySource.values()) delete configs[name];
        }
        continue;
      }
      for (const [otherId, configs] of winnersBySource) {
        if (otherId !== source.id) delete configs[name];
      }
      if (entry.enabled === false || vetoed.has(name)) continue;
      const configs = winnersBySource.get(source.id) ?? {};
      configs[name] = entry;
      winnersBySource.set(source.id, configs);
    }
  }
  return winnersBySource;
}

export type { McpServerConfig };
