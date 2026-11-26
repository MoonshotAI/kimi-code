import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { McpConnectionView } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpServerConfigEntry } from '#/mcpCore/config-override';

export const MCP_SOURCE_PRIORITY = {
  plugin: 0,
  user: 10,
  'project-root': 20,
  workspace: 30,
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

export type { McpServerConfig };
