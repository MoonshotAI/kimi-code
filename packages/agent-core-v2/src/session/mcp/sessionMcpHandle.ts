/**
 * `mcp` domain — seeded MCP shared-handle contract.
 *
 * Defines `ISessionMcpHandle`, the pure-data injection contract carrying the
 * workspace handler's one shared `McpConnectionManager` (all sessions of the
 * workspace connect through the same manager — no per-session connections
 * exist) plus the initial-connect readiness promise. The contract carries no
 * IO of its own. Session-scoped.
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
