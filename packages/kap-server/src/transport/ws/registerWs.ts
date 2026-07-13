/**
 * `/api/v2/ws` — creates the v2 (RPC) WebSocket server. The HTTP `upgrade`
 * event is dispatched by the bootstrap (`start.ts`), which routes by path so
 * this endpoint coexists with `/api/v1/ws`.
 *
 * Lifecycle / cleanup:
 *   - each connection is a {@link WsConnection}, tracked in the shared
 *     {@link IConnectionRegistry};
 *   - shutdown (close-all + wss.close) is owned by the bootstrap;
 *   - per-connection cleanup lives in {@link WsConnection}.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';
import { WebSocketServer } from 'ws';

import type { CredentialValidator } from '../../services/auth/credentials';
import { type IConnectionRegistry } from './connectionRegistry';
import { WsConnection } from './wsConnection';
import { selectWsBearerProtocol } from './bearerProtocol';

export interface RegisterWsOptions {
  /** Present-only credential validator forwarded to {@link WsConnection}. */
  readonly validateCredential?: CredentialValidator;
  readonly callTimeoutMs?: number;
  /** Registry that tracks live connections; populated by this module. */
  readonly registry: IConnectionRegistry;
}

export const WS_PATH = '/api/v2/ws';

export function registerWs(core: Scope, opts: RegisterWsOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });
  const { registry } = opts;

  wss.on('connection', (socket, req) => {
    const conn = new WsConnection({
      socket,
      core,
      validateCredential: opts.validateCredential,
      callTimeoutMs: opts.callTimeoutMs,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    registry.add(conn);
    socket.on('close', () => registry.remove(conn.id));
  });

  return wss;
}
