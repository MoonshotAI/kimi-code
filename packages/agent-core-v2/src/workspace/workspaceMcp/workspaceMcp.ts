/**
 * `workspaceMcp` domain — Workspace-scoped MCP subsystem contract.
 *
 * Defines `IWorkspaceMcpService`, the handler-level owner of the workspace's
 * ONE shared `McpConnectionManager`: connected at handler materialization
 * from the `workspaceMcpConfig` domain's effective server snapshot and
 * incrementally reconciled as its change events arrive. Sessions cannot
 * contribute MCP servers: there is no caller-supplied server channel on
 * session create/resume. Every session of the handler receives the manager
 * through the `ISessionMcpHandle` seed (`sessionHandle()`); no per-session
 * MCP connections exist. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';

export interface IWorkspaceMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): McpConnectionManager;

  sessionHandle(): ISessionMcpHandle;
}

export const IWorkspaceMcpService: ServiceIdentifier<IWorkspaceMcpService> =
  createDecorator<IWorkspaceMcpService>('workspaceMcpService');
