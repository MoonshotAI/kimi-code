import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpConnectionView } from '#/mcpCore/connection-manager';

export const MCP_SOURCE_PRIORITY = {
  project: 0,
  caller: 100,
} as const;

export interface McpSource {
  readonly id: string;
  readonly priority: number;
  readonly ready: Promise<void>;
  readonly view: McpConnectionView;
  readonly stdioCwd?: () => string;
  dispose?(): void | Promise<void>;
}

export const ISessionMcpSources: ServiceIdentifier<readonly McpSource[]> =
  createDecorator<readonly McpSource[]>('sessionMcpSources');

export function sessionMcpSourcesSeed(sources: readonly McpSource[]): ScopeSeed {
  return [[ISessionMcpSources as ServiceIdentifier<unknown>, sources]];
}
