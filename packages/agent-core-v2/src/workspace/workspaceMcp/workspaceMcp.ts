import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { ISessionMcpOverlayConnection } from '#/session/mcp/sessionMcpOverlay';

export interface ISessionMcpOverlay {
  readonly handle: ISessionMcpHandle;
  readonly connection: ISessionMcpOverlayConnection;
  shutdown(): Promise<void>;
}

export interface SessionMcpOverlayOptions {
  readonly stdioCwd?: string;
  readonly sessionId?: string;
}

export interface IWorkspaceMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): McpConnectionManager;

  sessionHandle(): ISessionMcpHandle;

  sessionOverlay(
    servers: Readonly<Record<string, McpServerConfig>>,
    opts?: SessionMcpOverlayOptions,
  ): ISessionMcpOverlay;
}

export const IWorkspaceMcpService: ServiceIdentifier<IWorkspaceMcpService> =
  createDecorator<IWorkspaceMcpService>('workspaceMcpService');
