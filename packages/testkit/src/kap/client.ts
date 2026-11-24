import { TestkitError, WaitTimeoutError } from '#/errors';
import { TIMEOUTS } from '#/fixtures/timeouts';
import { sleep } from '#/fixtures/wait';
import type { KapFrame, KapTurn } from '#/kap/frames';
import { KapRest } from '#/kap/rest';
import { KapSocket } from '#/kap/socket';
import type {
  KapContentPart,
  KapInteractionResponse,
  KapPendingInteraction,
  KapPromptItem,
  KapPromptQueue,
  KapSession,
  KapTurnsPage,
  KapWaitResult,
  PermissionMode,
} from '#/kap/types';

export interface KapEndpoint {
  origin(): string;
  token(): string;
}

export interface KapClientOptions {
  readonly workspace?: string;
  readonly onFrame?: (frame: KapFrame) => void;
}

export interface PromptOptions {
  readonly agentId?: string;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  readonly promptId?: string;
  readonly thinking?: string;
}

export interface CreateSessionOptions {
  readonly cwd?: string;
  readonly title?: string;
  readonly agentConfig?: Readonly<Record<string, unknown>>;
}

export interface WaitIdleOptions {
  readonly timeoutMs?: number;
  readonly onInteraction?: (interaction: KapPendingInteraction) => Promise<void>;
}

export class KapClient {
  private readonly endpoint: KapEndpoint;
  private readonly clientOptions: KapClientOptions;
  private readonly sockets = new Set<KapSocket>();

  constructor(endpoint: KapEndpoint, options: KapClientOptions = {}) {
    this.endpoint = endpoint;
    this.clientOptions = options;
  }

  get origin(): string {
    return this.endpoint.origin();
  }

  get wsUrl(): string {
    return `${this.origin.replace(/^http/, 'ws')}/api/v1/ws`;
  }

  get token(): string {
    return this.endpoint.token();
  }

  get rest(): KapRest {
    return new KapRest(this.origin, () => this.token);
  }

  async connect(): Promise<KapSocket> {
    const socket = await KapSocket.connect(this.wsUrl, this.token, this.clientOptions.onFrame);
    this.sockets.add(socket);
    return socket;
  }

  async createSession(options: CreateSessionOptions = {}): Promise<KapSession> {
    return this.rest.post<KapSession>('/api/v1/sessions', {
      cwd: options.cwd ?? this.clientOptions.workspace,
      title: options.title,
      agent_config: options.agentConfig,
    });
  }

  session(sessionId: string): Promise<KapSession> {
    return this.rest.get<KapSession>(sessionPath(sessionId));
  }

  prompt(sessionId: string, input: string | readonly KapContentPart[], options: PromptOptions = {}): Promise<KapPromptItem> {
    return this.rest.post<KapPromptItem>(`${sessionPath(sessionId)}/prompts`, promptBody(input, options));
  }

  steer(sessionId: string, input: string | readonly KapContentPart[], options: PromptOptions = {}): Promise<KapPromptItem> {
    return this.rest.post<KapPromptItem>(`${sessionPath(sessionId)}/steer`, promptBody(input, options));
  }

  prompts(sessionId: string): Promise<KapPromptQueue> {
    return this.rest.get<KapPromptQueue>(`${sessionPath(sessionId)}/prompts`);
  }

  async turns(sessionId: string, agentId = 'main'): Promise<KapTurn[]> {
    const pages: KapTurn[][] = [];
    let before: number | undefined;
    for (;;) {
      const page = await this.rest.get<KapTurnsPage>(`${sessionPath(sessionId)}/agents/${encodeURIComponent(agentId)}/turns`, {
        page_size: 200,
        before_ordinal: before,
      });
      pages.unshift([...page.turns]);
      const first = page.turns[0];
      if (!page.has_more || first === undefined) break;
      before = first.ordinal;
    }
    return pages.flat();
  }

  cancel(sessionId: string, options: { readonly agentId?: string; readonly includeBackground?: boolean } = {}): Promise<{ readonly cancelled: boolean }> {
    return this.rest.post(`${sessionPath(sessionId)}:cancel`, { agent_id: options.agentId, include_background: options.includeBackground });
  }

  undo(sessionId: string, turnId: string, agentId?: string): Promise<{ readonly removed_turn_ids: readonly string[] }> {
    return this.rest.post(`${sessionPath(sessionId)}:undo`, { turn_id: turnId, agent_id: agentId });
  }

  fork(sessionId: string, body: Readonly<Record<string, unknown>> = {}): Promise<KapSession> {
    return this.rest.post<KapSession>(`${sessionPath(sessionId)}:fork`, body);
  }

  compact(sessionId: string, instruction?: string): Promise<Record<string, never>> {
    return this.rest.post(`${sessionPath(sessionId)}:compact`, { instruction });
  }

  async interactions(sessionId: string): Promise<readonly KapPendingInteraction[]> {
    const result = await this.rest.get<{ readonly items: readonly KapPendingInteraction[] }>(`${sessionPath(sessionId)}/interactions`);
    return result.items;
  }

  answer(sessionId: string, interactionId: string, response: KapInteractionResponse): Promise<{ readonly outcome: string; readonly ended_at: string }> {
    return this.rest.post(`${sessionPath(sessionId)}/interactions/${encodeURIComponent(interactionId)}`, response);
  }

  wait(sessionId: string, timeoutMs: number): Promise<KapWaitResult> {
    return this.rest.post<KapWaitResult>(`${sessionPath(sessionId)}:wait`, { timeout_ms: Math.max(0, Math.min(60_000, timeoutMs)) });
  }

  async waitForInteraction(sessionId: string, options: { readonly timeoutMs?: number } = {}): Promise<KapPendingInteraction> {
    const deadline = Date.now() + (options.timeoutMs ?? TIMEOUTS.request);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new WaitTimeoutError(`Timed out waiting for a pending interaction in session ${sessionId}`);
      const result = await this.wait(sessionId, Math.min(remaining, 10_000));
      const [first] = result.pending_interactions;
      if (first !== undefined) return first;
      if (!result.timed_out) await sleep(25);
    }
  }

  async waitIdle(sessionId: string, options: WaitIdleOptions = {}): Promise<KapSession> {
    const timeoutMs = options.timeoutMs ?? TIMEOUTS.request;
    const deadline = Date.now() + timeoutMs;
    let last: KapSession | undefined;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new WaitTimeoutError(
          `Timed out after ${timeoutMs} ms waiting for session ${sessionId} to become idle (last state: ${JSON.stringify(last ?? null)})`,
        );
      }
      const waited = await this.wait(sessionId, Math.min(remaining, 10_000));
      last = waited.session;
      if (waited.pending_interactions.length > 0) {
        if (options.onInteraction === undefined) {
          throw new TestkitError(
            `Session ${sessionId} is waiting on ${waited.pending_interactions.length} interaction(s) (${waited.pending_interactions.map((item) => `${item.kind} ${item.interaction_id}`).join(', ')}); answer them or pass onInteraction to waitIdle`,
          );
        }
        for (const interaction of waited.pending_interactions) await options.onInteraction(interaction);
        continue;
      }
      if (waited.timed_out) continue;
      const [session, queue] = await Promise.all([this.session(sessionId), this.prompts(sessionId)]);
      last = session;
      if (session.activity === 'idle' && session.pending_interaction === 'none' && queue.active === null && queue.queued.length === 0) return session;
      await sleep(25);
    }
  }

  protected async closeSockets(): Promise<void> {
    const sockets = [...this.sockets];
    this.sockets.clear();
    await Promise.all(sockets.map((socket) => socket.close()));
  }
}

function sessionPath(sessionId: string): string {
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}`;
}

function promptBody(input: string | readonly KapContentPart[], options: PromptOptions): Record<string, unknown> {
  return {
    content: typeof input === 'string' ? [{ type: 'text', text: input }] : input,
    agent_id: options.agentId,
    model: options.model,
    permission_mode: options.permissionMode,
    prompt_id: options.promptId,
    thinking: options.thinking,
  };
}
