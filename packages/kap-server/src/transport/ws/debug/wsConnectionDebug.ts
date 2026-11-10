import {
  xstateInspectionCollector,
  type XstateInspectionCollector,
  type XstateInspectionEnvelope,
} from '@moonshot-ai/agent-core-v2/human/xstateInspection';
import type { WebSocket } from 'ws';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_MISS_LIMIT = 2;
const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_HIGH_WATER_MARK_BYTES = 1 << 20;

export interface WsConnectionDebugOptions {
  readonly socket: WebSocket;
  readonly collector?: XstateInspectionCollector;
  readonly heartbeatIntervalMs?: number;
  readonly flushIntervalMs?: number;
  readonly highWaterMarkBytes?: number;
}

export class WsConnectionDebug {
  private readonly socket: WebSocket;
  private readonly heartbeatIntervalMs: number;
  private readonly flushIntervalMs: number;
  private readonly highWaterMarkBytes: number;
  private readonly unsubscribe: () => void;

  private closed = false;
  private outbound: XstateInspectionEnvelope[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPongAt = Date.now();

  constructor(opts: WsConnectionDebugOptions) {
    this.socket = opts.socket;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.highWaterMarkBytes = opts.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;

    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());
    this.socket.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    const collector = opts.collector ?? xstateInspectionCollector;
    this.unsubscribe = collector.subscribe((envelope) => this.onEnvelope(envelope));

    this.heartbeatTimer = setInterval(() => this.onHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private onEnvelope(envelope: XstateInspectionEnvelope): void {
    if (this.closed) return;
    if (this.socket.bufferedAmount > this.highWaterMarkBytes) return;
    this.outbound.push(envelope);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (this.outbound.length === 0) return;
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      this.outbound = [];
      return;
    }
    const envelopes = this.outbound;
    this.outbound = [];
    for (const envelope of envelopes) {
      if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
      try {
        this.socket.send(JSON.stringify(envelope));
      } catch {
      }
    }
  }

  private onHeartbeat(): void {
    if (Date.now() - this.lastPongAt >= this.heartbeatIntervalMs * HEARTBEAT_MISS_LIMIT) {
      this.close();
      return;
    }
    try {
      this.socket.ping();
    } catch {
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.socket.close(1000);
    } catch {
    }
    this.onClose();
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.outbound = [];
    this.unsubscribe();
  }
}
