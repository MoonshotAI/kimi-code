/**
 * `mcp` domain (L5), Session scope — the session's shared MCP subsystem.
 *
 * Owns the session-wide `McpConnectionManager` (one per session, shared by
 * every agent, matching v1's session-scoped MCP and avoiding a reconnect
 * storm per agent), the initial connect attempt (`ensureMcpReady`), and its
 * telemetry. Split out of `agentLifecycle`: agent existence and MCP
 * connections are independent concerns — the lifecycle only needs to await
 * the initial connect before an agent's first turn and to seed the shared
 * manager into each agent scope. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager } from '#/agent/mcp/connection-manager';
import type { McpServerConfig } from '#/agent/mcp/config-schema';

export interface ISessionMcpService {
  readonly _serviceBrand: undefined;

  /**
   * Resolve the session/plugin MCP config and wait for the initial connection
   * attempt to finish. Per-server failures are reflected in MCP status entries
   * rather than rejecting this promise; an outright failure is logged.
   * `callerServers` (caller-supplied servers from session create) merge into
   * the initial connect between file config and plugin servers; the first
   * call wins — the initial load is cached and later calls ignore the arg.
   */
  ensureMcpReady(callerServers?: Readonly<Record<string, McpServerConfig>>): Promise<void>;

  /** The session's shared connection manager (built lazily, cached). */
  connectionManager(): McpConnectionManager;
}

export const ISessionMcpService: ServiceIdentifier<ISessionMcpService> =
  createDecorator<ISessionMcpService>('sessionMcpService');
