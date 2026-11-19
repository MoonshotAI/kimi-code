import { WebSocket, type RawData } from 'ws';

import { TestkitError } from '#/errors';
import { TIMEOUTS } from '#/fixtures/timeouts';
import { waitForEvent } from '#/fixtures/wait';
import { isConversationFrame, turnsFromFrames, type KapFrame, type KapTurn } from '#/kap/frames';

export const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export interface FrameWaitOptions {
  readonly timeoutMs?: number;
  readonly after?: number;
}

export interface SubscribeOptions extends FrameWaitOptions {
  readonly agentIds?: readonly string[];
  readonly waitForSnapshot?: boolean;
}

export class KapCommandError extends TestkitError {
  constructor(
    readonly command: string,
    readonly response: KapFrame,
  ) {
    super(`KAP command ${command} failed: ${JSON.stringify(response)}`);
    this.name = 'KapCommandError';
  }
}

export class KapSocket {
  private readonly received: KapFrame[] = [];
  private readonly unreadable: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly readyAgents = new Map<string, Set<string>>();
  private readonly unsubscribes = new Map<string, Readonly<Record<string, unknown>>>();
  private closeInfo: { readonly code: number; readonly reason: string } | undefined;
  private lastError: Error | undefined;
  private readonly closed: Promise<void>;
  private readonly opened: Promise<void>;
  private requests = 0;

  private constructor(private readonly socket: WebSocket, private readonly onFrame?: (frame: KapFrame) => void) {
    socket.on('message', (data: RawData) => this.onMessage(data));
    socket.on('error', (error: Error) => {
      this.lastError = error;
    });
    this.closed = new Promise((resolve) => {
      socket.once('close', (code: number, reason: Buffer) => {
        this.closeInfo = { code, reason: reason.toString('utf8') };
        this.notify();
        resolve();
      });
    });
    this.opened = new Promise((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('unexpected-response', (_request, response) => {
        reject(new TestkitError(`KAP WebSocket upgrade failed with HTTP ${response.statusCode ?? 'unknown'}`));
        response.resume();
        socket.terminate();
      });
    });
  }

  static async connect(url: string, token: string | undefined, onFrame?: (frame: KapFrame) => void): Promise<KapSocket> {
    const socket = new KapSocket(new WebSocket(url, token === undefined ? [] : [`${WS_BEARER_PROTOCOL_PREFIX}${token}`]), onFrame);
    await socket.opened;
    return socket;
  }

  get frames(): readonly KapFrame[] {
    return this.received;
  }

  get unreadableFrames(): readonly string[] {
    return this.unreadable;
  }

  get isClosed(): boolean {
    return this.closeInfo !== undefined;
  }

  mark(): number {
    return this.received.length;
  }

  send(frame: Readonly<Record<string, unknown>>): void {
    this.socket.send(JSON.stringify(frame));
    if (frame['type'] === 'unsubscribe' && typeof frame['request_id'] === 'string') this.unsubscribes.set(frame['request_id'], frame);
  }

  async command(frame: Readonly<Record<string, unknown>> & { readonly type: string }, options: FrameWaitOptions = {}): Promise<KapFrame> {
    this.requests += 1;
    const requestId = `testkit-${this.requests}`;
    const after = this.mark();
    this.send({ ...frame, request_id: requestId });
    const response = await this.waitFor((candidate) => candidate.type === 'response' && candidate['request_id'] === requestId, {
      ...options,
      after,
    });
    if (response['code'] !== 0) throw new KapCommandError(frame.type, response);
    return response;
  }

  async subscribe(sessionId: string, options: SubscribeOptions = {}): Promise<void> {
    const agentIds = options.agentIds ?? ['main'];
    const accepted = await this.command({ type: 'subscribe', session_id: sessionId, agent_ids: agentIds }, options);
    if (options.waitForSnapshot === false) return;
    const after = this.received.lastIndexOf(accepted) + 1;
    const pending = new Set(agentIds.filter((id) => !this.readyAgents.get(sessionId)?.has(id)));
    while (pending.size > 0) {
      const snapshot = await this.waitFor(
        (frame) => (frame.type === 'turns' || frame.type === 'turns.failed') && frame['session_id'] === sessionId && pending.has(String(frame['agent_id'])),
        { ...options, after },
      );
      if (snapshot.type === 'turns.failed') throw new KapCommandError('subscribe', snapshot);
      pending.delete(String(snapshot['agent_id']));
    }
  }

  waitFor(predicate: (frame: KapFrame) => boolean, options: FrameWaitOptions = {}): Promise<KapFrame> {
    const after = options.after ?? 0;
    const find = (): KapFrame | undefined => this.received.slice(after).find(predicate);
    const existing = find();
    if (existing !== undefined) return Promise.resolve(existing);
    if (this.closeInfo !== undefined) return Promise.reject(this.closedError());
    return waitForEvent<KapFrame>(
      (settle, fail) => {
        const check = (): void => {
          const found = find();
          if (found !== undefined) settle(found);
          else if (this.closeInfo !== undefined) fail(this.closedError());
        };
        this.listeners.add(check);
        return () => this.listeners.delete(check);
      },
      {
        timeoutMs: options.timeoutMs ?? TIMEOUTS.frame,
        describe: () => `a KAP frame matching the predicate after frame #${after}; ${this.describeFrames()}`,
      },
    );
  }

  conversation(sessionId?: string, agentId = 'main'): KapFrame[] {
    return this.received.filter(
      (frame) =>
        isConversationFrame(frame) && frame['agent_id'] === agentId && (sessionId === undefined || frame['session_id'] === sessionId),
    );
  }

  turns(sessionId?: string, agentId = 'main'): KapTurn[] {
    return turnsFromFrames(this.conversation(sessionId, agentId));
  }

  async close(): Promise<void> {
    if (this.closeInfo === undefined) this.socket.close();
    await this.closed;
  }

  private onMessage(data: RawData): void {
    const text = rawText(data);
    const frame = parseFrame(text);
    if (frame === undefined) {
      this.unreadable.push(text);
      this.notify();
      return;
    }
    if (frame.type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    this.received.push(frame);
    this.trackSubscription(frame);
    this.onFrame?.(frame);
    this.notify();
  }

  private trackSubscription(frame: KapFrame): void {
    if (frame.type === 'session' && (frame['change'] === 'archived' || frame['change'] === 'deleted')) {
      const session = frame['session'] as { readonly id?: unknown } | undefined;
      if (typeof session?.id === 'string') this.readyAgents.delete(session.id);
      return;
    }
    const session = frame['session_id'];
    const agent = frame['agent_id'];
    if (typeof session === 'string' && typeof agent === 'string') {
      if (frame.type === 'turns') {
        const ready = this.readyAgents.get(session) ?? new Set<string>();
        ready.add(agent);
        this.readyAgents.set(session, ready);
      } else if (frame.type === 'turns.failed' || (frame.type === 'agent' && frame['status'] === 'ended')) {
        this.readyAgents.get(session)?.delete(agent);
      }
    }
    if (frame.type !== 'response' || typeof frame['request_id'] !== 'string') return;
    const command = this.unsubscribes.get(frame['request_id']);
    this.unsubscribes.delete(frame['request_id']);
    if (frame['code'] !== 0 || typeof command?.['session_id'] !== 'string') return;
    const sessionId = command['session_id'];
    const agentIds = command['agent_ids'];
    if (Array.isArray(agentIds)) {
      for (const id of agentIds) this.readyAgents.get(sessionId)?.delete(String(id));
    } else {
      this.readyAgents.delete(sessionId);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private closedError(): TestkitError {
    const info = this.closeInfo;
    const error = this.lastError === undefined ? '' : ` after error ${JSON.stringify(this.lastError.message)}`;
    return new TestkitError(
      `The KAP WebSocket closed (code ${info?.code ?? 'unknown'}, reason ${JSON.stringify(info?.reason ?? '')})${error}; ${this.describeFrames()}`,
    );
  }

  private describeFrames(): string {
    const recent = this.received.slice(-8).map((frame) => frame.type);
    const unreadable = this.unreadable.length === 0 ? '' : `; ${this.unreadable.length} unreadable frame(s), first: ${JSON.stringify(this.unreadable[0]?.slice(0, 200))}`;
    return `received ${this.received.length} frame(s), latest: ${recent.join(', ') || 'none'}${unreadable}`;
  }
}

function parseFrame(text: string): KapFrame | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return undefined;
  return typeof (frame as { readonly type?: unknown }).type === 'string' ? (frame as KapFrame) : undefined;
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
