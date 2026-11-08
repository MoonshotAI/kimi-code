import { ErrorCodes, Error2, MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2';
import {
  subscribeMessageSchema,
  subscribeTowerMessageSchema,
  unsubscribeMessageSchema,
  unsubscribeTowerMessageSchema,
} from '../../../protocol/ws-control';
import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';

import { ErrorCode } from '../../../protocol/error-codes';
import { mapError } from '../../errors';
import type { IConnectionRegistry } from '../connectionRegistry';
import { buildPing, buildResponse } from './protocol';
import type {
  BroadcastDelivery,
  BroadcastFrame,
  BroadcastTarget,
  SessionEventBroadcaster,
} from './sessionEventBroadcaster';
import type { TowerWatchService } from '../../../services/tower/towerWatchService';
import { TaskRequests, type TaskSource } from './taskRequests';

const COMMAND_TYPES: ReadonlySet<string> = new Set([
  'subscribe',
  'unsubscribe',
  'tower.subscribe',
  'tower.unsubscribe',
  'task.watch',
  'task.unwatch',
  'task.stop',
  'task.background',
]);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_MISS_LIMIT = 2;

const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_HIGH_WATER_MARK_BYTES = 1 << 20;
const DEFAULT_BACKPRESSURE_RETRY_MS = 5;
const DEFAULT_BACKPRESSURE_MAX_DELAY_MS = 100;

interface InboundFrame {
  type: string;
  request_id?: unknown;
}

export interface WsConnectionV1Options {
  readonly socket: WebSocket;
  readonly broadcaster: SessionEventBroadcaster;
  readonly towerWatch: TowerWatchService;
  readonly taskSource: TaskSource;
  readonly connectionRegistry: IConnectionRegistry;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly highWaterMarkBytes?: number;
  readonly heartbeatIntervalMs?: number;
}

export class WsConnectionV1 implements BroadcastTarget {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;

  private readonly socket: WebSocket;
  private readonly broadcaster: SessionEventBroadcaster;
  private readonly towerWatch: TowerWatchService;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly highWaterMarkBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly taskRequests: TaskRequests;

  private closed = false;
  private controlQueue: Promise<void> = Promise.resolve();

  private outbound: unknown[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private backpressureRetryTimer?: ReturnType<typeof setTimeout>;
  private backpressureSince?: number;

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastInboundAt = Date.now();

  constructor(opts: WsConnectionV1Options) {
    this.id = `conn_${ulid()}`;
    this.connectedAt = new Date().toISOString();
    this.remoteAddress = opts.remoteAddress;
    this.userAgent = opts.userAgent;
    this.socket = opts.socket;
    this.broadcaster = opts.broadcaster;
    this.towerWatch = opts.towerWatch;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.highWaterMarkBytes = opts.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.taskRequests = new TaskRequests(opts.taskSource, {
      respond: (requestId, code, msg, task) => {
        this.sendImmediateFrame(buildResponse(requestId, code, msg, task));
      },
      output: (frame) => {
        this.sendSubscribedFrame(frame);
      },
    });

    this.socket.on('message', (data: RawData) => this.onMessage(data));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    opts.connectionRegistry.add(this);
    this.broadcaster.addGlobalTarget(this);
    this.heartbeatTimer = setInterval(() => {
      this.onHeartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  get subscriptionSessionIds(): readonly string[] {
    return this.broadcaster.sessionsOf(this);
  }

  send(frame: BroadcastFrame, delivery: BroadcastDelivery = 'subscription'): void {
    if (delivery === 'immediate') this.sendImmediateFrame(frame);
    else this.sendSubscribedFrame(frame);
  }

  private onMessage(data: RawData): void {
    if (this.closed) return;
    let frame: InboundFrame;
    try {
      frame = JSON.parse(rawDataToString(data)) as InboundFrame;
    } catch {
      return;
    }
    if (typeof frame?.type !== 'string') return;
    this.lastInboundAt = Date.now();
    if (!COMMAND_TYPES.has(frame.type)) return;

    const requestId = frame.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      this.close(1008, 'invalid message');
      return;
    }
    if (frame.type === 'subscribe') {
      this.enqueueControl(() => this.onSubscribe(requestId, frame));
    } else if (frame.type === 'unsubscribe') {
      this.enqueueControl(() => this.onUnsubscribe(requestId, frame));
    } else if (frame.type === 'tower.subscribe') {
      this.enqueueControl(() => this.onSubscribeTower(requestId, frame));
    } else if (frame.type === 'tower.unsubscribe') {
      this.enqueueControl(() => this.onUnsubscribeTower(requestId, frame));
    } else {
      this.taskRequests.handle(requestId, frame);
    }
  }

  private enqueueControl(task: () => Promise<void>): void {
    this.controlQueue = this.controlQueue.then(task).catch(() => {
    });
  }

  private onHeartbeat(): void {
    if (Date.now() - this.lastInboundAt >= this.heartbeatIntervalMs * HEARTBEAT_MISS_LIMIT) {
      this.close(1001, 'heartbeat timeout');
      return;
    }
    this.sendImmediateFrame(buildPing());
  }

  private async onSubscribe(requestId: string, frame: InboundFrame): Promise<void> {
    const parsed = subscribeMessageSchema.safeParse(frame);
    if (!parsed.success) {
      this.respond(requestId, ErrorCode.VALIDATION_FAILED, 'invalid subscribe message');
      return;
    }
    const { session_id: sid, agent_ids: agentIds } = parsed.data;
    try {
      await this.broadcaster.subscribe(sid, this, agentIds ?? [MAIN_AGENT_ID], () => {
        this.respond(requestId, ErrorCode.SUCCESS);
        this.broadcaster.sendPendingInteractions(sid, this);
      });
    } catch (error) {
      const failure = mapError(error, requestId);
      this.respond(requestId, failure.code, failure.msg);
      return;
    }
    if (this.closed) this.broadcaster.removeTarget(this);
  }

  private async onUnsubscribe(requestId: string, frame: InboundFrame): Promise<void> {
    const parsed = unsubscribeMessageSchema.safeParse(frame);
    if (!parsed.success) {
      this.respond(requestId, ErrorCode.VALIDATION_FAILED, 'invalid unsubscribe message');
      return;
    }
    this.broadcaster.unsubscribe(parsed.data.session_id, this, parsed.data.agent_ids);
    this.respond(requestId, ErrorCode.SUCCESS);
  }

  private respond(requestId: string, code: number, msg?: string): void {
    this.sendImmediateFrame(buildResponse(requestId, code, msg));
  }

  private async onSubscribeTower(requestId: string, frame: InboundFrame): Promise<void> {
    const parsed = subscribeTowerMessageSchema.safeParse(frame);
    if (!parsed.success) {
      this.respond(requestId, ErrorCode.VALIDATION_FAILED, 'invalid tower.subscribe message');
      return;
    }
    try {
      await this.towerWatch.subscribe(parsed.data.workspace_id, this);
    } catch (error) {
      if (error instanceof Error2 && error.code === ErrorCodes.WORKSPACE_NOT_FOUND) {
        this.respond(requestId, ErrorCode.WORKSPACE_NOT_FOUND, error.message);
        return;
      }
      const failure = mapError(error, requestId);
      this.respond(requestId, failure.code, failure.msg);
      return;
    }
    this.respond(requestId, ErrorCode.SUCCESS);
    if (this.closed) this.towerWatch.removeTarget(this);
  }

  private async onUnsubscribeTower(requestId: string, frame: InboundFrame): Promise<void> {
    const parsed = unsubscribeTowerMessageSchema.safeParse(frame);
    if (!parsed.success) {
      this.respond(requestId, ErrorCode.VALIDATION_FAILED, 'invalid tower.unsubscribe message');
      return;
    }
    this.towerWatch.unsubscribe(parsed.data.workspace_id, this);
    this.respond(requestId, ErrorCode.SUCCESS);
  }

  private sendSubscribedFrame(msg: unknown): void {
    if (this.closed) return;
    this.outbound.push(msg);
    if (this.outbound.length >= this.maxBatchSize) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private sendImmediateFrame(msg: unknown): void {
    if (this.closed) return;
    this.outbound.push(msg);
    this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private flush(force = false): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.outbound.length === 0) return;
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      this.outbound = [];
      return;
    }

    if (!force && this.socket.bufferedAmount > this.highWaterMarkBytes) {
      this.deferForBackpressure();
      return;
    }
    this.backpressureSince = undefined;

    const frames = this.outbound;
    this.outbound = [];
    for (const frame of frames) {
      if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
      try {
        this.socket.send(JSON.stringify(frame));
      } catch {
      }
    }
  }

  private deferForBackpressure(): void {
    const now = Date.now();
    if (this.backpressureSince === undefined) this.backpressureSince = now;
    if (now - this.backpressureSince >= DEFAULT_BACKPRESSURE_MAX_DELAY_MS) {
      this.flush(true);
      return;
    }
    if (this.backpressureRetryTimer !== undefined) return;
    this.backpressureRetryTimer = setTimeout(() => {
      this.backpressureRetryTimer = undefined;
      this.flush();
    }, DEFAULT_BACKPRESSURE_RETRY_MS);
    this.backpressureRetryTimer.unref?.();
  }

  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    this.flush(true);
    try {
      this.socket.close(code, reason);
    } catch {
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    if (this.backpressureRetryTimer !== undefined) clearTimeout(this.backpressureRetryTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.outbound = [];
    this.taskRequests.dispose();
    this.broadcaster.removeTarget(this);
    this.towerWatch.removeTarget(this);
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
