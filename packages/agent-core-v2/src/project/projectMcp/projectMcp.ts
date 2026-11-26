import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpSource } from '#/session/mcp/mcpSource';

export interface IProjectMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): McpConnectionManager;

  source(): McpSource;
}

export const IProjectMcpService: ServiceIdentifier<IProjectMcpService> =
  createDecorator<IProjectMcpService>('workspaceMcpService');
