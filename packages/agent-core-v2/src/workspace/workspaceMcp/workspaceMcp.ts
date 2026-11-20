import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpAnchor } from '#/app/mcpConfig/configLoader';
import type { McpConnectionManager, McpConnectionView } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';

export interface IWorkspaceMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): McpConnectionManager;

  definedNames(): ReadonlySet<string>;
}

export const IWorkspaceMcpService: ServiceIdentifier<IWorkspaceMcpService> =
  createDecorator<IWorkspaceMcpService>('workspaceMcpService');

export interface ProjectMcpServer {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly origin: string;
}

export interface SessionMcpOptions {
  readonly sessionId: string;
  readonly ephemeral: Readonly<Record<string, McpServerConfig>>;
}

export interface SessionMcpLease {
  readonly handle: ISessionMcpHandle;
  dispose(): Promise<void>;
}

export interface WorkdirMcp {
  readonly anchor: McpAnchor;
  readonly ready: Promise<void>;
  view(): McpConnectionView;
  configuredNames(): readonly string[];
  previewProjectServers(): Promise<readonly ProjectMcpServer[]>;
  sessionHandle(options: SessionMcpOptions): SessionMcpLease;
}
