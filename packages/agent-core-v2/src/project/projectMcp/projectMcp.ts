import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpSource } from '#/session/mcp/mcpSource';
import type { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';

export interface IProjectMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): MergedMcpConnectionView;

  sourceManager(sourceId: string): McpConnectionManager | undefined;

  sources(): readonly McpSource[];
}

export const IProjectMcpService: ServiceIdentifier<IProjectMcpService> =
  createDecorator<IProjectMcpService>('workspaceMcpService');
