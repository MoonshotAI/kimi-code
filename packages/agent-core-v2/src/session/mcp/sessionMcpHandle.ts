/**
 * `mcp` domain — seeded MCP shared-handle contract.
 *
 * Defines `ISessionMcpHandle`, the pure-data injection contract carrying the
 * session's MCP connection view plus the initial-connect readiness promise.
 * The view is the workspace handler's shared `McpConnectionManager` for
 * ordinary sessions, or a `MergedMcpConnectionView` over that manager and a
 * session-owned overlay manager when the session was created with ephemeral
 * MCP servers (`CreateSessionOptions.mcpServers`) — consumers never care
 * which manager owns a server. The contract carries no IO of its own.
 * Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpConnectionView } from '#/mcpCore/connection-manager';

export interface ISessionMcpHandle {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly connectionManager: McpConnectionView;
}

export const ISessionMcpHandle: ServiceIdentifier<ISessionMcpHandle> =
  createDecorator<ISessionMcpHandle>('sessionMcpHandle');

export function sessionMcpHandleSeed(handle: ISessionMcpHandle): ScopeSeed {
  return [[ISessionMcpHandle as ServiceIdentifier<unknown>, handle]];
}
