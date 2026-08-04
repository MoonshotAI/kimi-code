/**
 * `workspaceMcp` domain — Workspace-scoped MCP subsystem contract.
 *
 * Defines `IWorkspaceMcpService`, the handler-level owner of the workspace's
 * ONE shared `McpConnectionManager`: connected at handler materialization
 * from the `workspaceMcpConfig` domain's effective server snapshot and
 * incrementally reconciled as its change events arrive. Every session of the
 * handler receives the manager through the `ISessionMcpHandle` seed
 * (`sessionHandle()`). A session created with ephemeral MCP servers
 * (`CreateSessionOptions.mcpServers`) additionally gets a session overlay
 * (`sessionOverlay()`): a session-owned manager for those servers — never
 * persisted, never part of the config domain's effective set, invisible to
 * the handler's other sessions — presented to the session through a merged
 * view, and released by the caller (`shutdown()`) when the session scope
 * tears down. Ephemeral servers are a caller-explicit injection channel
 * (like the user-level `mcp.json`), so they are not gated by workspace
 * trust — only the project-level config files are. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';

export interface ISessionMcpOverlay {
  readonly handle: ISessionMcpHandle;
  shutdown(): Promise<void>;
}

export interface SessionMcpOverlayOptions {
  readonly stdioCwd?: string;
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
