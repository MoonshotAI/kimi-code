import { WebSocketServer } from 'ws';

import type { SessionV2Binder, V2SessionSource } from '../../../services/v2Projection/binder';
import type { GlobalV2Fanout } from '../../../services/v2Projection/globalFanout';
import { selectWsBearerProtocol } from '../bearerProtocol';
import type { IConnectionRegistry } from '../connectionRegistry';
import { WsConnectionV2, type WsConnectionV2Logger } from './wsConnectionV2';

export const WS_PATH_V2 = '/api/v2/ws';

export interface RegisterWsV2Options {
  readonly binder: SessionV2Binder;
  readonly registry: IConnectionRegistry;
  readonly serverId: string;
  readonly sessionSourceFor: (sessionId: string) => V2SessionSource | undefined;
  readonly globalFanout?: GlobalV2Fanout;
  readonly clock?: () => number;
  readonly outboundCapacity?: number;
  readonly inflightWindow?: number;
  readonly heartbeatIntervalMs?: number;
  readonly logger?: WsConnectionV2Logger;
}

export function registerWsV2(opts: RegisterWsV2Options): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });
  wss.on('connection', (socket, req) => {
    const connection = new WsConnectionV2({
      socket,
      binder: opts.binder,
      registry: opts.registry,
      serverId: opts.serverId,
      sessionSourceFor: opts.sessionSourceFor,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      globalFanout: opts.globalFanout,
      clock: opts.clock,
      outboundCapacity: opts.outboundCapacity,
      inflightWindow: opts.inflightWindow,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      logger: opts.logger,
    });
    socket.on('close', () => opts.registry.remove(connection.id));
  });
  return wss;
}
