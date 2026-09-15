import {
  xstateInspectionCollector,
  type XstateInspectionCollector,
  type XstateInspectionEnvelope,
} from '@moonshot-ai/agent-core-v2/human/xstateInspection';
import type { WebSocket } from 'ws';

const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_HIGH_WATER_MARK_BYTES = 1 << 20;

export interface WsConnectionDebugOptions {
  readonly socket: WebSocket;
  readonly collector?: XstateInspectionCollector;
  readonly flushIntervalMs?: number;
  readonly highWaterMarkBytes?: number;
}

export class WsConnectionDebug {
  private readonly socket: WebSocket;
  private readonly collector: XstateInspectionCollector;
  private readonly flushIntervalMs: number;
  private readonly highWaterMarkBytes: number;

  private closed = false;
  private collectorUnsubscribe?: () => void;
  private outbound: XstateInspectionEnvelope[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: WsConnectionDebugOptions) {
    this.socket = opts.socket;
    this.collector = opts.collector ?? xstateInspectionCollector;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.highWaterMarkBytes = opts.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;

    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());
    this.socket.on('message', (data) => this.onMessage(data));
  }

  private onMessage(data: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (frame === null || typeof frame !== 'object') return;
    const type = (frame as Record<string, unknown>)['type'];
    if (type === 'subscribe') {
      this.subscribe();
    } else if (type === 'unsubscribe') {
      this.unsubscribe();
    }
  }

  private subscribe(): void {
    if (this.closed || this.collectorUnsubscribe !== undefined) return;
    this.collectorUnsubscribe = this.collector.subscribe((envelope) => this.onEnvelope(envelope));
  }

  private unsubscribe(): void {
    if (this.collectorUnsubscribe === undefined) return;
    this.collectorUnsubscribe();
    this.collectorUnsubscribe = undefined;
    this.outbound = [];
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
    this.outbound = [];
    this.collectorUnsubscribe?.();
    this.collectorUnsubscribe = undefined;
  }
}
