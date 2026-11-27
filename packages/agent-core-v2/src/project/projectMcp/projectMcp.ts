import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpSource } from '#/session/mcp/mcpSource';
import type { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';

export interface IProjectMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): MergedMcpConnectionView;

  acquire(): Promise<() => Promise<void>>;

  sources(): readonly McpSource[];
}

export const IProjectMcpService: ServiceIdentifier<IProjectMcpService> =
  createDecorator<IProjectMcpService>('workspaceMcpService');
