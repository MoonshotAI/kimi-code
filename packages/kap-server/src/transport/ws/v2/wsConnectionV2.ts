import { ulid } from 'ulid';
import type { WebSocket } from 'ws';

import { ErrorCode } from '../../../protocol/error-codes';
import { clientMessageSchema, serverMessageSchema, type ServerMessage } from '../../../protocol/v2/messages/index';
import type { IConnectionRegistry } from '../connectionRegistry';
import type { SessionV2Binder, V2Disposable, V2SessionSource } from '../../../services/v2Projection/binder';
import type { GlobalV2Fanout } from '../../../services/v2Projection/globalFanout';

export const WS_V2_PROTOCOL_VERSION = 2;
export const WS_V2_CAPABILITIES = ['step_replay_v1', 'interaction_v1'] as const;
export const BACKPRESSURE_OVERFLOW_MESSAGE = 'outbound queue overflow; connection closed, reconnect to resync';

const DEFAULT_OUTBOUND_CAPACITY = 256;
const DEFAULT_INFLIGHT_WINDOW = 64;
const HEARTBEAT_MISS_LIMIT = 3;

export interface WsConnectionV2Logger {
  warn(meta: Record<string, unknown>, msg: string): void;
}

export interface WsConnectionV2Options {
  readonly socket: WebSocket;
  readonly binder: SessionV2Binder;
  readonly registry: IConnectionRegistry;
  readonly serverId: string;
  readonly sessionSourceFor: (sessionId: string) => V2SessionSource | undefined;
  readonly remoteAddress?: string | null;
  readonly userAgent?: string | null;
  readonly globalFanout?: GlobalV2Fanout;
  readonly clock?: () => number;
  readonly outboundCapacity?: number;
  readonly inflightWindow?: number;
  readonly heartbeatIntervalMs?: number;
  readonly logger?: WsConnectionV2Logger;
}

interface Subscription {
  sessionId: string;
  agentId: string;
  mainChannel: boolean;
  omit: ReadonlySet<string>;
  agentMessages: V2Disposable;
  sessionMessages?: V2Disposable;
}

export class WsConnectionV2 {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  private readonly clock: () => number;
  private readonly outboundCapacity: number;
  private readonly inflightWindow: number;
  private readonly heartbeatIntervalMs: number;
  private readonly subscriptions: Subscription[] = [];
  private readonly outboundQueue: string[] = [];
  private inflight = 0;
  private overflowed = false;
  private closed = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPongAt: number;
  private globalTarget?: V2Disposable;

  constructor(private readonly opts: WsConnectionV2Options) {
    this.id = ulid();
    this.connectedAt = new Date().toISOString();
    this.remoteAddress = opts.remoteAddress ?? null;
    this.userAgent = opts.userAgent ?? null;
    this.clock = opts.clock ?? Date.now;
    this.outboundCapacity = opts.outboundCapacity ?? DEFAULT_OUTBOUND_CAPACITY;
    this.inflightWindow = opts.inflightWindow ?? DEFAULT_INFLIGHT_WINDOW;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.lastPongAt = this.clock();
    const socket = opts.socket;
    socket.on('message', (data: unknown) => this.onMessage(data));
    socket.on('close', () => this.onClose());
    socket.on('pong', () => {
      this.lastPongAt = this.clock();
    });
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => this.onHeartbeat(), this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
    opts.registry.add(this);
    this.globalTarget = opts.globalFanout?.addTarget((msg) => this.send(msg));
    this.send({
      type: 'hello',
      protocol_version: WS_V2_PROTOCOL_VERSION,
      server_id: opts.serverId,
      capabilities: [...WS_V2_CAPABILITIES],
    } as ServerMessage);
  }

  get hasClientHello(): boolean {
    return true;
  }

  get subscriptionSessionIds(): readonly string[] {
    return [...new Set(this.subscriptions.map((subscription) => subscription.sessionId))];
  }

  close(code?: number, reason?: string): void {
    this.teardown();
    this.opts.socket.close(code, reason);
  }

  private onMessage(data: unknown): void {
    if (this.closed || this.overflowed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      this.sendError(ErrorCode.VALIDATION_FAILED, 'invalid JSON frame');
      return;
    }
    const parsed = clientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(ErrorCode.VALIDATION_FAILED, 'invalid client frame');
      return;
    }
    const frame = parsed.data;
    if (frame.type === 'subscribe') this.onSubscribe(frame.session_id, frame.agent_id, frame.omit, frame.id);
    else this.onUnsubscribe(frame.session_id, frame.id);
  }

  private onSubscribe(sessionId: string, agentId: string | undefined, omit: string[] | undefined, id: number): void {
    const source = this.opts.sessionSourceFor(sessionId);
    if (source === undefined) {
      this.send({ type: 'ack', id, code: ErrorCode.SESSION_NOT_FOUND });
      return;
    }
    const binding = this.opts.binder.attach(source);
    const targetAgentId = agentId ?? 'main';
    const mainChannel = agentId === undefined;
    const subscription: Subscription = {
      sessionId,
      agentId: targetAgentId,
      mainChannel,
      omit: new Set(omit ?? []),
      agentMessages: binding.agentFor(targetAgentId).onMessages((msgs) => this.sendMany(msgs, subscription.omit)),
    };
    if (mainChannel) {
      subscription.sessionMessages = binding.onSessionMessages((msgs) => this.sendMany(msgs, subscription.omit));
    }
    this.subscriptions.push(subscription);
    this.send({ type: 'ack', id, code: 0 });
    const recovery = binding.recoveryFor(targetAgentId);
    this.sendMany(recovery, subscription.omit);
  }

  private onUnsubscribe(sessionId: string, id: number): void {
    for (const subscription of this.subscriptions.filter((candidate) => candidate.sessionId === sessionId)) {
      subscription.agentMessages.dispose();
      subscription.sessionMessages?.dispose();
    }
    this.subscriptions.splice(0, this.subscriptions.length, ...this.subscriptions.filter((c) => c.sessionId !== sessionId));
    this.send({ type: 'ack', id, code: 0 });
  }

  private sendMany(msgs: readonly ServerMessage[], omit: ReadonlySet<string>): void {
    for (const msg of msgs) {
      if (omit.has(msg.type)) continue;
      this.send(msg);
    }
  }

  private send(msg: ServerMessage): void {
    if (this.closed || this.overflowed) return;
    const parsed = serverMessageSchema.safeParse(msg);
    if (!parsed.success) {
      this.opts.logger?.warn({ type: msg.type }, 'ws2 outbound dropped: contract violation');
      return;
    }
    if (this.outboundQueue.length >= this.outboundCapacity) {
      this.overflow();
      return;
    }
    this.outboundQueue.push(JSON.stringify(parsed.data));
    this.pump();
  }

  private sendError(code: number, msg: string): void {
    this.send({ type: 'error', code, msg } as ServerMessage);
  }

  private pump(): void {
    while (this.inflight < this.inflightWindow && this.outboundQueue.length > 0) {
      const data = this.outboundQueue.shift()!;
      this.inflight += 1;
      this.opts.socket.send(data, () => {
        this.inflight -= 1;
        this.pump();
      });
    }
  }

  private overflow(): void {
    if (this.overflowed) return;
    this.overflowed = true;
    const frame = JSON.stringify({
      type: 'error',
      code: 'backpressure_overflow',
      msg: BACKPRESSURE_OVERFLOW_MESSAGE,
    });
    try {
      this.opts.socket.send(frame, () => {});
    } catch {
    }
    this.teardown();
    this.opts.socket.close();
  }

  private onHeartbeat(): void {
    if (this.closed) return;
    if (this.clock() - this.lastPongAt >= this.heartbeatIntervalMs * HEARTBEAT_MISS_LIMIT) {
      this.opts.socket.close();
      return;
    }
    this.opts.socket.ping();
  }

  private onClose(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const subscription of this.subscriptions) {
      subscription.agentMessages.dispose();
      subscription.sessionMessages?.dispose();
    }
    this.subscriptions.length = 0;
    this.globalTarget?.dispose();
    this.opts.registry.remove(this.id);
  }
}
