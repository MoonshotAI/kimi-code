
import { noopTracer } from '../../contracts';
import type { CredentialStore, Tracer } from '../../contracts';
import { CONVERSATION_FRAME_TYPES, type ConversationFrame } from '../../conversation/types';
import type { TaskCommandResult } from '../types';
import type {
  WireAgentFeedFrame,
  WireEvent,
  WireInteraction,
  WireServerFrame,
  WireTaskEvent,
  WireTaskList,
  WireTaskState,
} from './wire';
import { logInfo, logWarn } from '../../lib/log';
import { utf8ByteLength } from '../../lib/taskOutput';

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

const STALE_SOCKET_MS = 25_000;
const STALE_CHECK_INTERVAL_MS = 5_000;

const SUBSCRIBE_RETRY_MAX_ATTEMPTS = 8;
const SUBSCRIBE_RETRY_BASE_DELAY_MS = 250;
const SUBSCRIBE_RETRY_MAX_DELAY_MS = 4_000;
const SUBSCRIBE_RETRY_SLOW_DELAY_MS = 30_000;
const PERMANENT_SUBSCRIBE_FAILURES: ReadonlySet<number> = new Set([40001, 40401, 40930]);

interface SubscribeRetry {
  sessionId: string;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  exhaustedNotified?: boolean;
}

export interface DaemonEventSocketHandlers {
  onWireEvent(event: WireEvent): void;
  onInteraction(interaction: WireInteraction): void;
  onInteractionsReset(sessionId: string): void;
  onConnectionState(connected: boolean): void;
  onError(code: number, msg: string, fatal: boolean): void;
  onConversation?(sessionId: string, agentId: string, frame: ConversationFrame): void;
  onConversationFailed?(sessionId: string, code: number, msg: string): void;
  onTaskList?(list: WireTaskList): void;
  onTask?(sessionId: string, agentId: string, task: WireTaskState): void;
  onAgentFeedFrame?(frame: WireAgentFeedFrame): void;
  onTaskOutput?(sessionId: string, agentId: string, taskId: string, offset: number, text: string): void;
  onTaskOutputFailed?(sessionId: string, agentId: string, taskId: string): void;
}

interface TaskOutputWatch {
  sessionId: string;
  agentId: string;
  taskId: string;
  endOffset?: number;
}

interface PendingTaskCommand {
  sessionId: string;
  agentId: string;
  resolve(result: TaskCommandResult): void;
  reject(error: Error): void;
}

export interface DaemonEventSocketOptions {
  wsUrl: string;
  handlers: DaemonEventSocketHandlers;
  tracer?: Tracer;
  credentialStore?: CredentialStore;
}

export class DaemonEventSocket {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;

  private readonly conversationSubscriptions = new Map<string, Set<string>>();
  private readonly taskOutputWatches = new Map<string, TaskOutputWatch>();
  private readonly pendingTaskWatches = new Map<string, TaskOutputWatch>();
  private readonly pendingTaskCommands = new Map<string, PendingTaskCommand>();
  private readonly pendingSubscribes = new Map<string, string>();
  private readonly subscribeRetries = new Map<string, SubscribeRetry>();

  private msgSeq = 0;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private lastActivityAt = 0;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  private readonly tracer: Tracer;

  constructor(private readonly opts: DaemonEventSocketOptions) {
    this.tracer = opts.tracer ?? noopTracer;
  }

  connect(): void {
    if (this.ws !== null || this.closed) return;

    this.lastActivityAt = Date.now();
    this.tracer.wsEvent?.({
      kind: 'lifecycle',
      event: 'connect',
      detail: { url: this.opts.wsUrl, attempt: this.reconnectAttempts },
    });
    const credential = this.opts.credentialStore?.getToken();
    const protocols =
      credential !== undefined ? [`${WS_BEARER_PROTOCOL_PREFIX}${credential}`] : undefined;
    const ws = new WebSocket(this.opts.wsUrl, protocols);
    this.ws = ws;

    ws.onopen = () => {
      this.tracer.wsEvent?.({ kind: 'lifecycle', event: 'open' });
      this.onOpen();
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.lastActivityAt = Date.now();
      try {
        const frame = JSON.parse(String(ev.data)) as WireServerFrame;
        this.tracer.wsEvent?.({ kind: 'in', frame });
        this.handleFrame(frame);
      } catch (error) {
        this.tracer.wsEvent?.({
          kind: 'lifecycle',
          event: 'parse-error',
          detail: { error: String(error) },
        });
        this.opts.handlers.onError(0, `Failed to parse WS frame: ${String(error)}`, false);
      }
    };

    ws.onerror = () => {
      this.tracer.wsEvent?.({ kind: 'lifecycle', event: 'error' });
      this.opts.handlers.onError(0, 'WebSocket error', false);
    };

    ws.onclose = (ev?: CloseEvent) => {
      this.tracer.wsEvent?.({
        kind: 'lifecycle',
        event: 'close',
        detail: ev ? { code: ev.code, reason: ev.reason, wasClean: ev.wasClean } : undefined,
      });
      this.connected = false;
      this.ws = null;
      this.clearSubscribeRetries();
      this.pendingSubscribes.clear();
      this.pendingTaskWatches.clear();
      this.failPendingTaskCommands();
      this.opts.handlers.onConnectionState(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const base = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    const delay = base + Math.floor(Math.random() * 250);
    this.reconnectAttempts += 1;
    this.tracer.wsEvent?.({
      kind: 'lifecycle',
      event: 'reconnect-scheduled',
      detail: { delayMs: delay, attempt: this.reconnectAttempts },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  subscribeConversation(sessionId: string, agentId: string): void {
    let agents = this.conversationSubscriptions.get(sessionId);
    if (agents === undefined) {
      agents = new Set();
      this.conversationSubscriptions.set(sessionId, agents);
    }
    agents.add(agentId);
    this.clearSubscribeRetry(sessionId);
    if (this.connected) this.sendSubscribe(sessionId, [...agents]);
  }

  unsubscribeConversation(sessionId: string, agentIds?: string[]): void {
    const agents = this.conversationSubscriptions.get(sessionId);
    if (agents !== undefined) {
      if (agentIds === undefined) {
        this.conversationSubscriptions.delete(sessionId);
      } else {
        for (const id of agentIds) agents.delete(id);
        if (agents.size === 0) this.conversationSubscriptions.delete(sessionId);
      }
    }
    if (!this.conversationSubscriptions.has(sessionId)) {
      this.clearSubscribeRetry(sessionId);
    }
    if (!this.connected || !this.ws) return;
    this.send({
      type: 'unsubscribe',
      request_id: this.nextId(),
      session_id: sessionId,
      ...(agentIds !== undefined ? { agent_ids: agentIds } : {}),
    });
  }

  watchTaskOutput(sessionId: string, agentId: string, taskId: string): void {
    const key = taskOutputKey(sessionId, agentId, taskId);
    if (this.taskOutputWatches.has(key)) return;
    const watch: TaskOutputWatch = { sessionId, agentId, taskId };
    this.taskOutputWatches.set(key, watch);
    if (this.connected) this.sendTaskWatch(watch);
  }

  unwatchTaskOutput(sessionId: string, agentId: string, taskId: string): void {
    const key = taskOutputKey(sessionId, agentId, taskId);
    if (!this.taskOutputWatches.delete(key)) return;
    if (!this.connected) return;
    this.send({
      type: 'task.unwatch',
      request_id: this.nextId(),
      session_id: sessionId,
      agent_id: agentId,
      task_id: taskId,
    });
  }

  sendTaskCommand(
    type: 'task.stop' | 'task.background',
    sessionId: string,
    agentId: string,
    taskId: string,
  ): Promise<TaskCommandResult> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error('WebSocket is not connected'));
    }
    const requestId = this.nextId();
    return new Promise((resolve, reject) => {
      this.pendingTaskCommands.set(requestId, { sessionId, agentId, resolve, reject });
      this.send({
        type,
        request_id: requestId,
        session_id: sessionId,
        agent_id: agentId,
        task_id: taskId,
      });
    });
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.stopStaleCheck();
    this.clearSubscribeRetries();
    this.pendingSubscribes.clear();
    this.failPendingTaskCommands();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }

  health(): { connected: boolean; open: boolean; stale: boolean } {
    const open = this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    return { connected: this.connected, open, stale: this.isStale() };
  }

  reconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.ws;
    if (old !== null) {
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      try {
        old.close(1000, 'reconnect');
      } catch {}
    }
    const wasConnected = this.connected;
    this.ws = null;
    this.connected = false;
    this.clearSubscribeRetries();
    this.pendingSubscribes.clear();
    this.pendingTaskWatches.clear();
    this.failPendingTaskCommands();
    if (wasConnected) {
      this.opts.handlers.onConnectionState(false);
    }
    this.connect();
  }

  private handleFrame(rawFrame: WireServerFrame): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const frame = rawFrame as any;
    const rawType = (rawFrame as { type: string }).type;
    if (rawType === 'interaction') {
      this.opts.handlers.onInteraction(frame as WireInteraction);
      return;
    }
    if (rawType === 'task.list') {
      this.opts.handlers.onTaskList?.(frame as WireTaskList);
      return;
    }
    if (rawType === 'task') {
      const task = frame as WireTaskEvent;
      this.opts.handlers.onTask?.(task.session_id, task.agent_id, task);
      return;
    }
    if (rawType === 'agent' || rawType === 'context' || rawType === 'goal' || rawType === 'todo') {
      this.opts.handlers.onAgentFeedFrame?.(frame as WireAgentFeedFrame);
      return;
    }
    if (CONVERSATION_FRAME_TYPES.has(rawType)) {
      const { session_id: sessionId, agent_id: agentId } = frame;
      if (typeof sessionId !== 'string' || typeof agentId !== 'string') {
        this.opts.handlers.onError(0, `Invalid ${rawType} frame`, false);
        return;
      }
      if (this.conversationSubscriptions.get(sessionId)?.has(agentId) !== true) return;
      this.opts.handlers.onConversation?.(sessionId, agentId, frame as ConversationFrame);
      return;
    }
    if (rawType === 'task.output') {
      this.onTaskOutputFrame(frame as Record<string, unknown>);
      return;
    }
    if (rawType === 'response') {
      this.onResponseFrame(frame as Record<string, unknown>);
      return;
    }
    if (rawType === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (
      rawType.startsWith('event.') ||
      rawType === 'session' ||
      rawType === 'workspace' ||
      rawType === 'config' ||
      rawType === 'invalidated'
    ) {
      this.opts.handlers.onWireEvent(frame as WireEvent);
    }
  }

  private onOpen(): void {
    this.connected = true;
    this.reconnectAttempts = 0;
    this.lastActivityAt = Date.now();
    this.startStaleCheck();
    this.opts.handlers.onConnectionState(true);

    for (const [sessionId, agents] of this.conversationSubscriptions) {
      this.sendSubscribe(sessionId, [...agents]);
    }
    for (const watch of this.taskOutputWatches.values()) {
      this.sendTaskWatch(watch);
    }
  }

  private isStale(): boolean {
    return this.lastActivityAt > 0 && Date.now() - this.lastActivityAt > STALE_SOCKET_MS;
  }

  private startStaleCheck(): void {
    if (this.staleCheckTimer !== null) return;
    this.staleCheckTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && this.isStale()) {
        this.tracer.wsEvent?.({ kind: 'lifecycle', event: 'stale-reconnect' });
        this.reconnect();
      }
    }, STALE_CHECK_INTERVAL_MS);
  }

  private stopStaleCheck(): void {
    if (this.staleCheckTimer === null) return;
    clearInterval(this.staleCheckTimer);
    this.staleCheckTimer = null;
  }

  private sendTaskWatch(watch: TaskOutputWatch): void {
    const requestId = this.nextId();
    this.pendingTaskWatches.set(requestId, watch);
    this.send({
      type: 'task.watch',
      request_id: requestId,
      session_id: watch.sessionId,
      agent_id: watch.agentId,
      task_id: watch.taskId,
      ...(watch.endOffset !== undefined ? { since_offset: watch.endOffset } : {}),
    });
  }

  private onTaskOutputFrame(frame: Record<string, unknown>): void {
    const { session_id: sessionId, agent_id: agentId, task_id: taskId, offset, text } = frame;
    if (
      typeof sessionId !== 'string' ||
      typeof agentId !== 'string' ||
      typeof taskId !== 'string' ||
      typeof offset !== 'number' ||
      typeof text !== 'string'
    ) {
      return;
    }
    const watch = this.taskOutputWatches.get(taskOutputKey(sessionId, agentId, taskId));
    if (watch === undefined) return;
    watch.endOffset = offset + utf8ByteLength(text);
    this.opts.handlers.onTaskOutput?.(sessionId, agentId, taskId, offset, text);
  }

  private onResponseFrame(frame: Record<string, unknown>): void {
    const requestId = frame['request_id'];
    if (typeof requestId !== 'string') return;
    const task = frame['task'] as WireTaskState | undefined;
    const code = typeof frame['code'] === 'number' ? frame['code'] : -1;
    const msg = typeof frame['msg'] === 'string' ? frame['msg'] : undefined;
    const subscribedSessionId = this.pendingSubscribes.get(requestId);
    if (subscribedSessionId !== undefined) {
      this.pendingSubscribes.delete(requestId);
      this.onSubscribeResponse(subscribedSessionId, code, msg);
      return;
    }
    const command = this.pendingTaskCommands.get(requestId);
    if (command !== undefined) {
      this.pendingTaskCommands.delete(requestId);
      if (task !== undefined) this.opts.handlers.onTask?.(command.sessionId, command.agentId, task);
      command.resolve({ code, msg });
      return;
    }
    const watch = this.pendingTaskWatches.get(requestId);
    if (watch === undefined) return;
    this.pendingTaskWatches.delete(requestId);
    if (task !== undefined) this.opts.handlers.onTask?.(watch.sessionId, watch.agentId, task);
    if (code === 0) return;
    const key = taskOutputKey(watch.sessionId, watch.agentId, watch.taskId);
    if (this.taskOutputWatches.get(key) !== watch) return;
    this.taskOutputWatches.delete(key);
    logWarn('task output watch failed', {
      sessionId: watch.sessionId,
      agentId: watch.agentId,
      taskId: watch.taskId,
      code: frame['code'],
      msg: frame['msg'],
    });
    this.opts.handlers.onTaskOutputFailed?.(watch.sessionId, watch.agentId, watch.taskId);
  }

  private onSubscribeResponse(sessionId: string, code: number, msg: string | undefined): void {
    if (code === 0) {
      if (this.subscribeRetries.has(sessionId)) {
        logInfo('session event subscribe restored', { sessionId });
      }
      this.clearSubscribeRetry(sessionId);
      this.opts.handlers.onInteractionsReset(sessionId);
      return;
    }
    if (!PERMANENT_SUBSCRIBE_FAILURES.has(code)) this.scheduleSubscribeRetry(sessionId, code);
    this.opts.handlers.onConversationFailed?.(sessionId, code, msg ?? '');
  }

  private failPendingTaskCommands(): void {
    const pending = [...this.pendingTaskCommands.values()];
    this.pendingTaskCommands.clear();
    for (const command of pending) {
      command.reject(new Error('WebSocket closed before the task command was answered'));
    }
  }

  private scheduleSubscribeRetry(sessionId: string, code: number): void {
    if (this.closed || !this.conversationSubscriptions.has(sessionId)) return;
    let retry = this.subscribeRetries.get(sessionId);
    if (retry === undefined) {
      retry = { sessionId, attempts: 0, timer: null };
      this.subscribeRetries.set(sessionId, retry);
      logWarn('session event subscribe failed; scheduling retry', { sessionId, code });
    }
    if (retry.timer !== null) return;
    const slow = retry.attempts >= SUBSCRIBE_RETRY_MAX_ATTEMPTS;
    if (slow && retry.exhaustedNotified !== true) {
      retry.exhaustedNotified = true;
      logWarn('session event subscribe retry budget exhausted; falling back to slow retry', {
        sessionId,
        attempts: retry.attempts,
      });
    }
    const delay = slow
      ? SUBSCRIBE_RETRY_SLOW_DELAY_MS
      : Math.min(
          SUBSCRIBE_RETRY_MAX_DELAY_MS,
          SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** retry.attempts,
        );
    retry.timer = setTimeout(() => this.fireSubscribeRetry(sessionId), delay);
    this.tracer.wsEvent?.({
      kind: 'lifecycle',
      event: 'subscribe-retry-scheduled',
      detail: { sessionId, attempt: retry.attempts + 1, delayMs: delay },
    });
  }

  private fireSubscribeRetry(sessionId: string): void {
    const retry = this.subscribeRetries.get(sessionId);
    if (retry === undefined) return;
    retry.timer = null;
    if (this.closed || !this.connected) return;
    const agents = this.conversationSubscriptions.get(sessionId);
    if (agents === undefined) {
      this.subscribeRetries.delete(sessionId);
      return;
    }
    retry.attempts += 1;
    logInfo('session event subscribe retry', { sessionId, attempt: retry.attempts });
    this.tracer.wsEvent?.({
      kind: 'lifecycle',
      event: 'subscribe-retry',
      detail: { sessionId, attempt: retry.attempts },
    });
    this.sendSubscribe(sessionId, [...agents]);
  }

  private clearSubscribeRetry(sessionId: string): void {
    const retry = this.subscribeRetries.get(sessionId);
    if (retry === undefined) return;
    if (retry.timer !== null) clearTimeout(retry.timer);
    this.subscribeRetries.delete(sessionId);
  }

  private clearSubscribeRetries(): void {
    for (const retry of this.subscribeRetries.values()) {
      if (retry.timer !== null) clearTimeout(retry.timer);
    }
    this.subscribeRetries.clear();
  }

  private sendSubscribe(sessionId: string, agentIds: string[]): void {
    if (agentIds.length === 0) return;
    for (const [requestId, pendingSessionId] of this.pendingSubscribes) {
      if (pendingSessionId === sessionId) this.pendingSubscribes.delete(requestId);
    }
    const requestId = this.nextId();
    this.pendingSubscribes.set(requestId, sessionId);
    this.send({
      type: 'subscribe',
      request_id: requestId,
      session_id: sessionId,
      agent_ids: agentIds,
    });
  }

  private send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
      this.tracer.wsEvent?.({ kind: 'out', frame: msg });
    } catch {}
  }

  private nextId(): string {
    return `c_${++this.msgSeq}`;
  }
}

function taskOutputKey(sessionId: string, agentId: string, taskId: string): string {
  return `${sessionId}\0${agentId}\0${taskId}`;
}