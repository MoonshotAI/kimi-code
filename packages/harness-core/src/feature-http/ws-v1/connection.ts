import { randomUUID } from 'node:crypto';

import type { RawData, WebSocket } from 'ws';

import type { EventEnvelope, SessionCursor } from './journal';
import {
  buildAck,
  buildPing,
  buildResyncRequired,
  buildServerHello,
  type ResyncReason,
  WS_PROTOCOL_VERSION,
} from './protocol';
import type {
  AgentFilter,
  BroadcastTarget,
  SessionBroadcaster,
  TargetSubscription,
} from './sessionState';
import { detachGrades, type TranscriptGrade, type TranscriptGradeSpec } from './transcriptModel';

const DEFAULT_MAX_BUFFER_SIZE = 1000;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_MISS_LIMIT = 2;

const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_HIGH_WATER_MARK_BYTES = 1 << 20;
const DEFAULT_BACKPRESSURE_RETRY_MS = 5;
const DEFAULT_BACKPRESSURE_MAX_DELAY_MS = 100;

type SessionSubscription = TargetSubscription;

interface InboundFrame {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
}

export interface WsV1ConnectionOptions {
  readonly socket: WebSocket;
  readonly broadcaster: SessionBroadcaster;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  readonly maxBufferSize?: number;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly highWaterMarkBytes?: number;
  readonly heartbeatIntervalMs?: number;
}

export class WsV1Connection implements BroadcastTarget {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;

  private readonly socket: WebSocket;
  private readonly broadcaster: SessionBroadcaster;
  private readonly maxBufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly highWaterMarkBytes: number;
  private readonly heartbeatIntervalMs: number;

  private closed = false;
  private gotClientHello = false;
  readonly subscriptions = new Map<string, SessionSubscription>();
  private controlQueue: Promise<void> = Promise.resolve();

  private outbound: unknown[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private backpressureRetryTimer?: ReturnType<typeof setTimeout>;
  private backpressureSince?: number;

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastInboundAt = Date.now();

  constructor(opts: WsV1ConnectionOptions) {
    this.id = `conn_${randomUUID()}`;
    this.connectedAt = new Date().toISOString();
    this.remoteAddress = opts.remoteAddress;
    this.userAgent = opts.userAgent;
    this.socket = opts.socket;
    this.broadcaster = opts.broadcaster;
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.highWaterMarkBytes = opts.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

    this.socket.on('message', (data: RawData) => this.onMessage(data));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    this.broadcaster.addGlobalTarget(this);
    this.sendImmediateFrame(
      buildServerHello({
        ws_connection_id: this.id,
        protocol_version: WS_PROTOCOL_VERSION,
        heartbeat_ms: this.heartbeatIntervalMs,
        max_event_buffer_size: this.maxBufferSize,
        capabilities: { event_batching: false, compression: false },
      }),
    );
    this.heartbeatTimer = setInterval(() => {
      this.onHeartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  get hasClientHello(): boolean {
    return this.gotClientHello;
  }

  get subscriptionSessionIds(): readonly string[] {
    return Array.from(this.subscriptions.keys()).toSorted();
  }

  transcriptGradesBySession(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [sessionId, sub] of this.subscriptions) {
      if (sub.transcriptGrades === undefined) continue;
      const grades: Record<string, string> = {};
      for (const [agentId, grade] of Object.entries(sub.transcriptGrades)) {
        if (grade !== undefined) grades[agentId] = grade;
      }
      if (Object.keys(grades).length > 0) out[sessionId] = grades;
    }
    return out;
  }

  send(envelope: EventEnvelope, delivery: 'subscription' | 'immediate' = 'subscription'): void {
    if (delivery === 'immediate') this.sendImmediateFrame(envelope);
    else this.sendSubscribedFrame(envelope);
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

    switch (frame.type) {
      case 'pong':
        return;
      case 'client_hello':
        this.enqueueControl(() => this.onClientHello(frame));
        return;
      case 'subscribe':
        this.enqueueControl(() => this.onSubscribe(frame));
        return;
      case 'subscribe_v2':
        this.enqueueControl(() => this.onSubscribeV2(frame));
        return;
      case 'unsubscribe_v2':
        this.enqueueControl(() => this.onUnsubscribeV2(frame));
        return;
      case 'unsubscribe':
        this.enqueueControl(() => this.onUnsubscribe(frame));
        return;
      default:
        return;
    }
  }

  private enqueueControl(task: () => Promise<void>): void {
    this.controlQueue = this.controlQueue.then(task).catch(() => {});
  }

  private onHeartbeat(): void {
    if (Date.now() - this.lastInboundAt >= this.heartbeatIntervalMs * HEARTBEAT_MISS_LIMIT) {
      this.close(1001, 'heartbeat timeout');
      return;
    }
    this.sendImmediateFrame(buildPing(randomUUID()));
  }

  private async onClientHello(frame: InboundFrame): Promise<void> {
    this.gotClientHello = true;

    const payload = frame.payload ?? {};
    const subscriptions = asStringArray(payload['subscriptions']);
    const cursors = payload['cursors'] as Record<string, SessionCursor> | undefined;
    const agentFilter = parseAgentFilter(payload['agent_filter']);

    const accepted: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    for (const sid of subscriptions) {
      await this.attachSession(
        sid,
        cursors?.[sid],
        agentFilter?.[sid],
        this.subscriptions.get(sid)?.transcriptGrades,
        undefined,
        { accepted, resyncRequired, serverCursors },
      );
    }

    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted_subscriptions: accepted,
        resync_required: resyncRequired,
        cursors: serverCursors,
      }),
    );
  }

  private async onSubscribe(frame: InboundFrame): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionIds = asStringArray(payload['session_ids']);
    const cursors = payload['cursors'] as Record<string, SessionCursor> | undefined;
    const agentFilter = parseAgentFilter(payload['agent_filter']);

    const accepted: string[] = [];
    const notFound: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    for (const sid of sessionIds) {
      await this.attachSession(
        sid,
        cursors?.[sid],
        agentFilter?.[sid],
        this.subscriptions.get(sid)?.transcriptGrades,
        undefined,
        { accepted, resyncRequired, serverCursors, notFound },
      );
    }

    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted,
        not_found: notFound,
        resync_required: resyncRequired,
        cursors: serverCursors,
      }),
    );
  }

  private async onSubscribeV2(frame: InboundFrame): Promise<void> {
    const parsed = parseSubscribeV2Payload(frame.payload ?? {});
    if (parsed === undefined) {
      this.sendImmediateFrame(buildAck(frame.id ?? '', 1, 'invalid subscribe_v2 payload', {}));
      return;
    }
    const sid = parsed.sessionId;

    const accepted: string[] = [];
    const notFound: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    await this.attachSession(
      sid,
      undefined,
      this.subscriptions.get(sid)?.agentFilter,
      parsed.transcript,
      parsed.transcriptSince,
      { accepted, resyncRequired, serverCursors, notFound },
    );

    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted,
        not_found: notFound,
        resync_required: resyncRequired,
        cursors: serverCursors,
      }),
    );
  }

  private async onUnsubscribeV2(frame: InboundFrame): Promise<void> {
    const payload = frame.payload ?? {};
    const sid = typeof payload['session_id'] === 'string' ? payload['session_id'] : undefined;
    const agentIdsRaw = payload['agent_ids'];
    const agentIds =
      Array.isArray(agentIdsRaw) && agentIdsRaw.length > 0 && agentIdsRaw.every((v) => typeof v === 'string')
        ? (agentIdsRaw as string[])
        : undefined;
    if (sid === undefined || sid.length === 0 || (agentIdsRaw !== undefined && agentIds === undefined)) {
      this.sendImmediateFrame(buildAck(frame.id ?? '', 1, 'invalid unsubscribe_v2 payload', {}));
      return;
    }

    const existing = this.subscriptions.get(sid);
    if (existing !== undefined) {
      this.broadcaster.unsubscribeTranscript(sid, this, agentIds);
      this.subscriptions.set(sid, {
        agentFilter: existing.agentFilter,
        transcriptGrades:
          agentIds === undefined ? undefined : detachGrades(existing.transcriptGrades, agentIds),
      });
    }

    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted: [sid],
        not_found: [],
        resync_required: [],
      }),
    );
  }

  private async onUnsubscribe(frame: InboundFrame): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionIds = asStringArray(payload['session_ids']);
    for (const sid of sessionIds) {
      this.broadcaster.unsubscribe(sid, this);
      this.subscriptions.delete(sid);
    }
    this.sendImmediateFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted: [],
        not_found: [],
        resync_required: [],
      }),
    );
  }

  private async attachSession(
    sid: string,
    cursor: SessionCursor | undefined,
    filter: AgentFilter,
    transcriptGrades: TranscriptGradeSpec | undefined,
    transcriptSince: Record<string, number> | undefined,
    collectors: {
      accepted: string[];
      resyncRequired: string[];
      serverCursors: Record<string, { seq: number; epoch?: string }>;
      notFound?: string[];
    },
  ): Promise<void> {
    const { accepted, resyncRequired, serverCursors, notFound } = collectors;
    const ok = await this.broadcaster.subscribe(sid, this, filter, transcriptGrades, {
      deferTranscriptReset: cursor !== undefined,
      transcriptSince,
    });
    if (!ok) {
      if (notFound !== undefined) notFound.push(sid);
      else resyncRequired.push(sid);
      return;
    }
    this.subscriptions.set(sid, { agentFilter: filter, transcriptGrades });
    accepted.push(sid);
    if (cursor !== undefined) {
      await this.replay(sid, cursor, filter, transcriptGrades, resyncRequired, serverCursors);
      await this.broadcaster.flushTranscriptSeed(sid, this);
    } else {
      const cur = await this.broadcaster.getCursor(sid);
      serverCursors[sid] = cur;
    }
  }

  private async replay(
    sid: string,
    cursor: SessionCursor,
    filter: AgentFilter,
    transcriptGrades: TranscriptGradeSpec | undefined,
    resyncRequired: string[],
    serverCursors: Record<string, { seq: number; epoch?: string }>,
  ): Promise<void> {
    const result = await this.broadcaster.getBufferedSince(sid, cursor, filter, transcriptGrades);
    if (result.resyncRequired !== false) {
      this.sendImmediateFrame(
        buildResyncRequired(sid, result.resyncRequired as ResyncReason, result.currentSeq, result.epoch),
      );
      resyncRequired.push(sid);
    } else {
      for (const { envelope } of result.events) this.sendSubscribedFrame(envelope);
    }
    serverCursors[sid] = { seq: result.currentSeq, epoch: result.epoch };
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

    const frames = coalesceFrames(this.outbound);
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
    this.broadcaster.removeGlobalTarget(this);
    for (const sid of this.subscriptions.keys()) this.broadcaster.unsubscribe(sid, this);
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function parseAgentFilter(value: unknown): Record<string, AgentFilter> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, AgentFilter> = {};
  for (const [sid, ids] of Object.entries(value)) {
    if (!Array.isArray(ids)) continue;
    const set = new Set(ids.filter((v): v is string => typeof v === 'string'));
    if (set.size === 0) continue;
    out[sid] = set;
  }
  return out;
}

const TRANSCRIPT_GRADES: ReadonlySet<string> = new Set(['off', 'turn', 'block', 'delta']);

function parseGradeSpec(value: unknown): TranscriptGradeSpec | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, TranscriptGrade> = {};
  for (const [agentId, grade] of Object.entries(value)) {
    if (typeof grade !== 'string' || !TRANSCRIPT_GRADES.has(grade)) return undefined;
    out[agentId] = grade as TranscriptGrade;
  }
  return out;
}

function parseTranscriptSince(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [agentId, seq] of Object.entries(value)) {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return undefined;
    out[agentId] = seq;
  }
  return out;
}

function parseSubscribeV2Payload(
  payload: Record<string, unknown>,
):
  | { sessionId: string; transcript: TranscriptGradeSpec; transcriptSince?: Record<string, number> }
  | undefined {
  const sessionId = payload['session_id'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  const transcript = parseGradeSpec(payload['transcript']);
  if (transcript === undefined) return undefined;
  const transcriptSince = parseTranscriptSince(payload['transcript_since']);
  if (payload['transcript_since'] !== undefined && transcriptSince === undefined) return undefined;
  return { sessionId, transcript, transcriptSince };
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

interface CoalescableDelta {
  type: 'assistant.delta' | 'thinking.delta';
  seq: number;
  volatile: true;
  offset?: number;
  session_id?: string;
  timestamp: string;
  payload: {
    agentId?: string;
    turnId?: number;
    delta: string;
    [key: string]: unknown;
  };
}

function isCoalescableDelta(frame: unknown): frame is CoalescableDelta {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f['volatile'] !== true) return false;
  const type = f['type'];
  if (type !== 'assistant.delta' && type !== 'thinking.delta') return false;
  const payload = f['payload'];
  if (typeof payload !== 'object' || payload === null) return false;
  return typeof (payload as Record<string, unknown>)['delta'] === 'string';
}

export function coalesceFrames(frames: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const frame of frames) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      isCoalescableDelta(last) &&
      isCoalescableDelta(frame) &&
      last.type === frame.type &&
      last.session_id === frame.session_id &&
      last.payload.agentId === frame.payload.agentId &&
      last.payload.turnId === frame.payload.turnId
    ) {
      out[out.length - 1] = {
        ...last,
        payload: { ...last.payload, delta: last.payload.delta + frame.payload.delta },
      };
    } else {
      out.push(frame);
    }
  }
  return out;
}
