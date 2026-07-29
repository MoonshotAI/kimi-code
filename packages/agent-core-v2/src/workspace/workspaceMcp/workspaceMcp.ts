/**
 * `workspaceMcp` domain (L5) — Workspace-scoped MCP subsystem contract.
 *
 * Defines `IWorkspaceMcpService`, the handler-level owner of the workspace's
 * ONE shared `McpConnectionManager`: built and connected at handler
 * materialization from exactly two sources — the MCP config files and the
 * enabled plugins (on a name collision the file config wins) — and reloaded
 * when a watched MCP config file changes or plugins reload. Sessions cannot
 * contribute MCP servers: there is no caller-supplied server channel on
 * session create/resume. Every session of the handler receives the manager
 * through the `ISessionMcpHandle` seed (`sessionHandle()`); no per-session
 * MCP connections exist. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/agent/mcp/connection-manager';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';

export interface IWorkspaceMcpService {
  readonly _serviceBrand: undefined;

  /**
   * The handler's initial connect (file config + plugin servers). Settles
   * once the initial connection attempt finishes; per-server failures are
   * reflected in MCP status entries rather than rejecting this promise.
   */
  readonly ready: Promise<void>;

  /**
   * The handler's shared connection manager. Always available, independent
   * of the initial connect's progress; global timeout defaults are read from
   * `config` at each (re)connect.
   */
  connectionManager(): McpConnectionManager;

  sessionHandle(): ISessionMcpHandle;
}

export const IWorkspaceMcpService: ServiceIdentifier<IWorkspaceMcpService> =
  createDecorator<IWorkspaceMcpService>('workspaceMcpService');
