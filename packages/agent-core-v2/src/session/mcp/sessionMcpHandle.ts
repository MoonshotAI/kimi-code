/**
 * `mcp` domain (L5) — seeded MCP shared-handle contract.
 *
 * Defines `ISessionMcpHandle`, the pure-data injection contract the
 * Workspace-scope `workspaceMcp` service hands to every Session scope it
 * creates: the handler's one shared `McpConnectionManager` (all sessions of
 * the workspace connect through the same manager — no per-session
 * connections exist) plus the initial-connect readiness promise. The contract
 * carries no IO of its own — connecting, reloading and watching MCP config
 * files live on the workspace side. Seeded into the Session scope by
 * `sessionLifecycle` when the session is materialized; the Agent-scope `mcp`
 * mirror resolves it upward through the scope tree. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpConnectionManager } from '#/mcpCore/connection-manager';

export interface ISessionMcpHandle {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly connectionManager: McpConnectionManager;
}

export const ISessionMcpHandle: ServiceIdentifier<ISessionMcpHandle> =
  createDecorator<ISessionMcpHandle>('sessionMcpHandle');

export function sessionMcpHandleSeed(handle: ISessionMcpHandle): ScopeSeed {
  return [[ISessionMcpHandle as ServiceIdentifier<unknown>, handle]];
}
