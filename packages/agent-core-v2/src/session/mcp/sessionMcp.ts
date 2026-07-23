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

  /**
   * Resolve the session/plugin MCP config and wait for the initial connection
   * attempt to finish. The initial connect waits for `config.ready` so global
   * timeout preferences apply deterministically. Per-server failures are
   * reflected in MCP status entries rather than rejecting this promise; an
   * outright failure is logged. `callerServers` (caller-supplied servers from
   * session create) merge into the initial connect between file config and
   * plugin servers; the first call wins — the initial load is cached and
   * later calls ignore the arg.
   */
  ensureMcpReady(callerServers?: Readonly<Record<string, McpServerConfig>>): Promise<void>;

  /**
   * The session's shared connection manager. Built lazily on first call and
   * always available, independent of the initial connect's progress; global
   * timeout defaults are read from `config` at each (re)connect.
   */
  connectionManager(): McpConnectionManager;
}

export const ISessionMcpService: ServiceIdentifier<ISessionMcpService> =
  createDecorator<ISessionMcpService>('sessionMcpService');
