import { TestkitError, WaitTimeoutError } from '#/errors';
import { mergeKimiConfig, writeKimiConfig, type KimiConfig } from '#/fixtures/config';
import { testEnv } from '#/fixtures/env';
import { createTestHome, type TestHome } from '#/fixtures/home';
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
import type { FakeModel } from '#/model/fake-model';
import { fakeModelConfig, type FakeProviderOptions } from '#/model/provider-config';

export interface KapHostIdentity {
  readonly productName: string;
  readonly version: string;
  readonly platform: string;
}

export interface KapAuthTokenService {
  readonly _serviceBrand: undefined;
  getToken(): string;
  isValid(candidate: string): Promise<boolean>;
}

export interface KapLaunchOptions {
  readonly hostIdentity: KapHostIdentity;
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logLevel?: string;
  readonly logger?: unknown;
  readonly skipInstanceRegistry?: boolean;
  readonly authTokenService?: KapAuthTokenService;
}

export interface KapRunningServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartKapOptions<O extends KapLaunchOptions, S extends KapRunningServer> {
  readonly startServer: (options: O) => Promise<S>;
  readonly model?: FakeModel;
  readonly provider?: FakeProviderOptions;
  readonly config?: KimiConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly serverOptions?: Partial<O>;
  readonly home?: TestHome;
  readonly isolateHome?: boolean;
  readonly onFrame?: (frame: KapFrame) => void;
  readonly token?: string;
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

export const TESTKIT_HOST_IDENTITY: KapHostIdentity = { productName: 'testkit', version: '0.0.0-test', platform: 'testkit' };

const BASE_CONFIG: KimiConfig = {
  extra: { model_catalog: { refresh_on_start: false, refresh_interval_ms: 0 } },
};

export class KapHarness<S extends KapRunningServer = KapRunningServer> {
  private running: S;
  private readonly sockets = new Set<KapSocket>();
  private restoreHome: (() => void) | undefined;
  private closed = false;

  private constructor(
    private readonly options: StartKapOptions<KapLaunchOptions, S>,
    readonly home: TestHome,
    private readonly ownsHome: boolean,
    readonly token: string,
    server: S,
    restoreHome: (() => void) | undefined,
  ) {
    this.running = server;
    this.restoreHome = restoreHome;
  }

  static async start<O extends KapLaunchOptions, S extends KapRunningServer>(options: StartKapOptions<O, S>): Promise<KapHarness<S>> {
    const home = options.home ?? (await createTestHome('testkit-kap'));
    const token = options.token ?? `testkit-${Math.random().toString(36).slice(2)}`;
    if (options.model !== undefined) await options.model.listen();
    const config = [BASE_CONFIG, options.model === undefined ? {} : fakeModelConfig(options.model, options.provider), options.config ?? {}].reduce(
      (merged, next) => mergeKimiConfig(merged, next),
    );
    await writeKimiConfig(home.dataDir, config);
    const restoreHome = options.isolateHome === false ? undefined : pointHomeAt(home.home);
    const generic = options as unknown as StartKapOptions<KapLaunchOptions, S>;
    try {
      const server = await launch(generic, home, token);
      return new KapHarness(generic, home, options.home === undefined, token, server, restoreHome);
    } catch (error) {
      restoreHome?.();
      if (options.home === undefined) await home.remove();
      throw error;
    }
  }

  get server(): S {
    return this.running;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.running.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.running.port}/api/v1/ws`;
  }

  get rest(): KapRest {
    return new KapRest(this.origin, () => this.token);
  }

  async connect(): Promise<KapSocket> {
    const socket = await KapSocket.connect(this.wsUrl, this.token, this.options.onFrame);
    this.sockets.add(socket);
    return socket;
  }

  async createSession(options: CreateSessionOptions = {}): Promise<KapSession> {
    return this.rest.post<KapSession>('/api/v1/sessions', {
      cwd: options.cwd ?? this.home.workspace,
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

  async restart(): Promise<void> {
    await this.closeSockets();
    await this.running.close();
    this.running = await launch(this.options, this.home, this.token);
  }

  async writeConfig(config: KimiConfig): Promise<void> {
    await writeKimiConfig(this.home.dataDir, config);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.closeSockets();
      await this.running.close();
    } finally {
      this.restoreHome?.();
      this.restoreHome = undefined;
      if (this.ownsHome) await this.home.remove();
    }
  }

  private async closeSockets(): Promise<void> {
    const sockets = [...this.sockets];
    this.sockets.clear();
    await Promise.all(sockets.map((socket) => socket.close()));
  }
}

export function startKap<O extends KapLaunchOptions, S extends KapRunningServer>(options: StartKapOptions<O, S>): Promise<KapHarness<S>> {
  return KapHarness.start(options);
}

function launch<S extends KapRunningServer>(options: StartKapOptions<KapLaunchOptions, S>, home: TestHome, token: string): Promise<S> {
  const authTokenService: KapAuthTokenService = {
    _serviceBrand: undefined,
    getToken: () => token,
    isValid: (candidate) => Promise.resolve(candidate === token),
  };
  return options.startServer({
    hostIdentity: TESTKIT_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home.dataDir,
    env: testEnv({ set: { HOME: home.home, ...options.env } }),
    logLevel: 'silent',
    skipInstanceRegistry: true,
    authTokenService,
    ...options.serverOptions,
  });
}

interface HomeOverride {
  readonly home: string;
}

const homeOverrides: HomeOverride[] = [];
let homeBeforeOverrides: Readonly<Record<'HOME' | 'USERPROFILE', string | undefined>> | undefined;

function pointHomeAt(home: string): () => void {
  if (homeOverrides.length === 0) homeBeforeOverrides = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
  const override: HomeOverride = { home };
  homeOverrides.push(override);
  applyHome(home);
  return () => {
    const index = homeOverrides.indexOf(override);
    if (index === -1) return;
    homeOverrides.splice(index, 1);
    const current = homeOverrides.at(-1);
    if (current !== undefined) {
      applyHome(current.home);
      return;
    }
    for (const [key, value] of Object.entries(homeBeforeOverrides ?? {})) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    homeBeforeOverrides = undefined;
  };
}

function applyHome(home: string): void {
  process.env['HOME'] = home;
  if (process.platform === 'win32') process.env['USERPROFILE'] = home;
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
