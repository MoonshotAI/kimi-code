import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';

import { ErrorCode } from '../../../protocol/error-codes';
import {
  clientMessageSchema,
  serverMessageSchema,
  type ServerMessage,
  type SubscribeMessage,
} from '../../../protocol/messages';
import type { IConnectionRegistry } from '../connectionRegistry';
import type { LaneSubscriber } from './sessionLane';
import type { WsV3Logger } from './wsV3Deps';
import type { WsV3Hub } from './wsV3Hub';

export const V3_PROTOCOL_VERSION = '3';
export const V3_CAPABILITIES: readonly string[] = ['step_replay_v1'];

const DEFAULT_MAX_OUTBOUND_MESSAGES = 1000;
const DEFAULT_HIGH_WATER_MARK_BYTES = 1 << 20;
const DEFAULT_BACKPRESSURE_RETRY_MS = 5;
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_MISS_LIMIT = 2;

export interface SubscriptionFilter {
  readonly agentIds?: ReadonlySet<string>;
  readonly omit: ReadonlySet<string>;
}

export function makeSubscriptionFilter(frame: SubscribeMessage): SubscriptionFilter {
  return {
    agentIds: frame.agent_ids === undefined ? undefined : new Set(frame.agent_ids),
    omit: new Set(frame.omit ?? []),
  };
}

export function passesSubscriptionFilter(
  filter: SubscriptionFilter,
  message: ServerMessage,
): boolean {
  if (filter.omit.has(message.type)) return false;
  if (
    filter.agentIds !== undefined &&
    'agent_id' in message &&
    !filter.agentIds.has(message.agent_id)
  ) {
    return false;
  }
  return true;
}

export interface WsConnectionV3Options {
  readonly socket: WebSocket;
  readonly hub: WsV3Hub;
  readonly connectionRegistry?: IConnectionRegistry;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  readonly serverId: string;
  readonly logger?: WsV3Logger;
  readonly maxOutboundMessages?: number;
  readonly highWaterMarkBytes?: number;
  readonly backpressureRetryMs?: number;
  readonly stallTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
}

export class WsConnectionV3 {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;

  private readonly socket: WebSocket;
  private readonly hub: WsV3Hub;
  private readonly logger?: WsV3Logger;
  private readonly maxOutboundMessages: number;
  private readonly highWaterMarkBytes: number;
  private readonly backpressureRetryMs: number;
  private readonly stallTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;

  private readonly subscriptions = new Map<string, LaneSubscriber>();
  private outbound: string[] = [];
  private drainTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private missedPongs = 0;
  private stallSince?: number;
  private closed = false;

  constructor(opts: WsConnectionV3Options) {
    this.id = `conn_${ulid()}`;
    this.connectedAt = new Date().toISOString();
    this.remoteAddress = opts.remoteAddress;
    this.userAgent = opts.userAgent;
    this.socket = opts.socket;
    this.hub = opts.hub;
    this.logger = opts.logger;
    this.maxOutboundMessages = opts.maxOutboundMessages ?? DEFAULT_MAX_OUTBOUND_MESSAGES;
    this.highWaterMarkBytes = opts.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;
    this.backpressureRetryMs = opts.backpressureRetryMs ?? DEFAULT_BACKPRESSURE_RETRY_MS;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

    this.socket.on('message', (data: RawData) => this.onRaw(data));
    this.socket.on('pong', () => {
      this.missedPongs = 0;
    });
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    opts.connectionRegistry?.add(this);
    this.hub.addConnection(this);
    this.sendImmediate({
      type: 'hello',
      protocol_version: V3_PROTOCOL_VERSION,
      server_id: opts.serverId,
      capabilities: [...V3_CAPABILITIES],
    });
    this.heartbeatTimer = setInterval(() => this.onHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  get hasClientHello(): boolean {
    return true;
  }

  get subscriptionSessionIds(): readonly string[] {
    return Array.from(this.subscriptions.keys()).toSorted();
  }

  trackSubscription(sessionId: string, sub: LaneSubscriber): void {
    this.subscriptions.set(sessionId, sub);
  }

  untrackSubscription(sessionId: string): void {
    this.subscriptions.delete(sessionId);
  }

  subscriptionFor(sessionId: string): LaneSubscriber | undefined {
    return this.subscriptions.get(sessionId);
  }

  enqueue(message: ServerMessage): void {
    if (this.closed) return;
    const validated = this.validateOutbound(message);
    if (validated === undefined) return;
    if (this.outbound.length >= this.maxOutboundMessages) {
      this.overflow();
      return;
    }
    this.outbound.push(JSON.stringify(validated));
    this.drain();
  }

  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    try {
      this.socket.close(code, reason);
    } catch {
      this.onClose();
    }
  }

  private onRaw(data: RawData): void {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      this.enqueue({
        type: 'error',
        code: ErrorCode.REQUEST_MALFORMED,
        msg: 'frame is not valid JSON',
      });
      return;
    }
    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) {
      const type = (parsed as { readonly type?: unknown } | null)?.type;
      this.enqueue({
        type: 'error',
        code: ErrorCode.VALIDATION_FAILED,
        msg:
          typeof type === 'string'
            ? `unknown or invalid frame type: ${type}`
            : 'frame failed client message validation',
      });
      return;
    }
    const frame = result.data;
    if (frame.type === 'subscribe') {
      this.hub.subscribeSession(this, frame);
    } else {
      this.hub.unsubscribeSession(this, frame.session_id, frame.id);
    }
  }

  private onHeartbeat(): void {
    this.missedPongs += 1;
    if (this.missedPongs >= HEARTBEAT_MISS_LIMIT) {
      this.logger?.warn(
        { connId: this.id, remoteAddress: this.remoteAddress },
        'ws v3: heartbeat timeout, terminating connection',
      );
      try {
        this.socket.terminate();
      } catch {
        this.onClose();
      }
      return;
    }
    try {
      this.socket.ping();
    } catch {
    }
  }

  private overflow(): void {
    if (this.closed) return;
    this.logger?.warn(
      { connId: this.id, remoteAddress: this.remoteAddress, queued: this.outbound.length },
      'ws v3: outbound queue overflow, closing slow consumer',
    );
    this.sendImmediate({
      type: 'error',
      code: ErrorCode.WS_SLOW_CONSUMER,
      msg: 'outbound queue overflow: slow consumer',
    });
    this.outbound = [];
    this.close(1008, 'slow consumer');
  }

  private drain(): void {
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      this.outbound = [];
      return;
    }
    while (this.outbound.length > 0) {
      if (this.socket.bufferedAmount > this.highWaterMarkBytes) {
        this.deferDrain();
        return;
      }
      const frame = this.outbound.shift();
      if (frame === undefined) break;
      try {
        this.socket.send(frame);
      } catch {
      }
    }
    this.stallSince = undefined;
  }

  private deferDrain(): void {
    const now = Date.now();
    this.stallSince ??= now;
    if (now - this.stallSince >= this.stallTimeoutMs) {
      this.overflow();
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drain();
    }, this.backpressureRetryMs);
    this.drainTimer.unref?.();
  }

  private sendImmediate(message: ServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    const validated = this.validateOutbound(message);
    if (validated === undefined) return;
    try {
      this.socket.send(JSON.stringify(validated));
    } catch {
    }
  }

  private validateOutbound(message: ServerMessage): ServerMessage | undefined {
    const parsed = serverMessageSchema.safeParse(message);
    if (parsed.success) return parsed.data;
    this.logger?.warn(
      {
        connId: this.id,
        type: (message as { readonly type?: unknown }).type,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      'ws v3: outbound message failed schema validation, dropped',
    );
    return undefined;
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.outbound = [];
    this.hub.dropConnection(this);
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
