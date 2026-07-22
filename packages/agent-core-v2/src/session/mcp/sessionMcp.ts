/**
 * `mcp` domain (L5) — session-scoped MCP subsystem contract.
 *
 * Defines `ISessionMcpService` for connecting the session's servers and
 * exposing their shared connection manager. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/agent/mcp/connection-manager';
import type { McpServerConfig } from '#/agent/mcp/config-schema';

export interface ISessionMcpService {
  readonly _serviceBrand: undefined;

  ensureMcpReady(callerServers?: Readonly<Record<string, McpServerConfig>>): Promise<void>;

  connectionManager(): McpConnectionManager;
}

export const ISessionMcpService: ServiceIdentifier<ISessionMcpService> =
  createDecorator<ISessionMcpService>('sessionMcpService');
