import type { Scope } from '@moonshot-ai/agent-core-v2';
import { WebSocketServer } from 'ws';

import type { CredentialValidator } from '../../../services/auth/credentials';
import { type IConnectionRegistry } from '../connectionRegistry';
import type { SessionEventBroadcaster } from './sessionEventBroadcaster';
import type { JournalLogger } from './sessionEventJournal';
import { WsConnectionV1 } from './wsConnectionV1';
import { selectWsBearerProtocol } from '../bearerProtocol';

export const WS_PATH = '/api/v1/ws';

const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

const PER_MESSAGE_DEFLATE = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  concurrencyLimit: 8,
  zlibDeflateOptions: { level: 3, memLevel: 8 },
};

export interface WsTuning {
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly highWaterMarkBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxBufferSize?: number;
  readonly compression?: boolean;
  readonly maxPayloadBytes?: number;
}

export interface RegisterWsV1Options extends WsTuning {
  readonly validateCredential?: CredentialValidator;
  readonly registry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly logger?: JournalLogger;
}

export function parseWsTuning(env: NodeJS.ProcessEnv): WsTuning {
  return {
    flushIntervalMs: parsePositiveInt(env['KIMI_CODE_WS_FLUSH_INTERVAL_MS']),
    maxBatchSize: parsePositiveInt(env['KIMI_CODE_WS_MAX_BATCH_SIZE']),
    highWaterMarkBytes: parsePositiveInt(env['KIMI_CODE_WS_HIGH_WATER_MARK_BYTES']),
    heartbeatIntervalMs: parsePositiveInt(env['KIMI_CODE_WS_HEARTBEAT_MS']),
    maxBufferSize: parsePositiveInt(env['KIMI_CODE_WS_MAX_BUFFER_SIZE']),
    compression: parseBoolean(env['KIMI_CODE_WS_COMPRESSION']),
    maxPayloadBytes: parsePositiveInt(env['KIMI_CODE_WS_MAX_PAYLOAD_BYTES']),
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
}

export function registerWsV1(core: Scope, opts: RegisterWsV1Options): WebSocketServer {
  void core;
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: selectWsBearerProtocol,
    maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    perMessageDeflate: opts.compression === false ? false : PER_MESSAGE_DEFLATE,
  });
  const { registry, broadcaster } = opts;

  wss.on('connection', (socket, req) => {
    const conn = new WsConnectionV1({
      socket,
      broadcaster,
      connectionRegistry: registry,
      validateCredential: opts.validateCredential,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      logger: opts.logger,
      maxBufferSize: opts.maxBufferSize,
      flushIntervalMs: opts.flushIntervalMs,
      maxBatchSize: opts.maxBatchSize,
      highWaterMarkBytes: opts.highWaterMarkBytes,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
    });
    socket.on('close', () => registry.remove(conn.id));
  });

  return wss;
}
