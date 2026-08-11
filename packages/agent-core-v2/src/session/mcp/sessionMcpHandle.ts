/**
 * `mcp` domain — seeded MCP shared-handle contract.
 *
 * Defines `ISessionMcpHandle`, the pure-data injection contract carrying the
 * session's MCP connection view plus the initial-connect readiness promise.
 * The view is the workspace handler's shared `McpConnectionManager` for
 * ordinary sessions, or a `MergedMcpConnectionView` over that manager and a
 * session-owned overlay manager when the session was created with ephemeral
 * MCP servers (`CreateSessionOptions.mcpServers`) — consumers never care
 * which manager owns a server. `isBaselineServer` carries the session's
 * server baseline: the names captured when the session materialized (open
 * to additions until the initial connect settles, then closed). Servers
 * that appear later — a plugin install or a config edit — are not part of
 * the session, so live agents must not register their tools; a fresh
 * baseline is captured on the next session materialization (`/new`,
 * `/reload`, resume). The contract carries no IO of its own.
 * Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpConnectionView } from '#/mcpCore/connection-manager';

export interface ISessionMcpHandle {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly connectionManager: McpConnectionView;
  isBaselineServer(name: string): boolean;
}

export const ISessionMcpHandle: ServiceIdentifier<ISessionMcpHandle> =
  createDecorator<ISessionMcpHandle>('sessionMcpHandle');

export function sessionMcpHandleSeed(handle: ISessionMcpHandle): ScopeSeed {
  return [[ISessionMcpHandle as ServiceIdentifier<unknown>, handle]];
}
