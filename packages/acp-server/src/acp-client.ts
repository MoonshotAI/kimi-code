/**
 * Outbound (agent → client) ACP surface, adapted from the SDK's app-API
 * {@link AgentContext}.
 *
 * The new `agent()` app API exposes outbound calls only through the generic
 * `AgentContext.request` / `AgentContext.notify` pair (the typed legacy
 * `AgentSideConnection` helpers are `@deprecated`). This module restores the
 * narrow typed surface the server actually consumes — `session/update`,
 * `session/request_permission`, the `fs/*` reverse-RPC (see
 * `./acp-fs/acpConnection`'s {@link IAcpFsClient}) and the `terminal/*`
 * reverse-RPC ({@link IAcpTerminalClient}) — as plain method-name calls, so
 * `AcpServer` / `AcpSession` / `AcpInteractionBridge` stay transport-agnostic.
 */

import {
  type AgentContext,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  methods,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputResponse,
  type WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

import type { IAcpFsClient, IAcpTerminalClient, IAcpTerminalHandle } from './acp-fs';

/**
 * The outbound ACP client surface used across the server. Structurally
 * satisfies {@link IAcpFsClient} + {@link IAcpTerminalClient} so it can be
 * bound into the App-scope `IAcpConnection` holder directly.
 */
export interface AcpClient extends IAcpFsClient, IAcpTerminalClient {
  /** Send a `session/update` notification to the client. */
  sessionUpdate(params: SessionNotification): Promise<void>;
  /** Reverse-RPC `session/request_permission` (approval / ask-user bridge). */
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/**
 * Build the {@link AcpClient} over an app-API {@link AgentContext} (the
 * `client` handle of an `AgentConnection`).
 */
export function acpClientFromContext(client: AgentContext): AcpClient {
  return {
    sessionUpdate: (params) => client.notify(methods.client.session.update, params),
    requestPermission: (params) =>
      client.request(methods.client.session.requestPermission, params),
    readTextFile: (params) => client.request(methods.client.fs.readTextFile, params),
    writeTextFile: (params) => client.request(methods.client.fs.writeTextFile, params),
    createTerminal: async (params) => {
      // Explicit generics: the literal-method overload does not reduce for
      // this params shape (nullable optionals), so the call is pinned to the
      // typed `terminal/create` request/response here.
      const { terminalId } = await client.request<CreateTerminalResponse, CreateTerminalRequest>(
        methods.client.terminal.create,
        params,
      );
      return new ContextTerminalHandle(terminalId, params.sessionId, client);
    },
  };
}

/**
 * `terminal/*` handle over the generic context — mirrors the legacy SDK
 * `TerminalHandle` method-for-method (same methods, same params).
 */
class ContextTerminalHandle implements IAcpTerminalHandle {
  constructor(
    readonly id: string,
    private readonly sessionId: string,
    private readonly client: AgentContext,
  ) {}

  currentOutput(): Promise<TerminalOutputResponse> {
    return this.client.request(methods.client.terminal.output, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  waitForExit(): Promise<WaitForTerminalExitResponse> {
    return this.client.request(methods.client.terminal.waitForExit, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  kill(): Promise<unknown> {
    return this.client.request(methods.client.terminal.kill, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  release(): Promise<unknown> {
    return this.client.request(methods.client.terminal.release, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }
}
