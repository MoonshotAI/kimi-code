import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthConnectionError, OAuthUnauthorizedError } from '@moonshot-ai/kimi-code-oauth';
import { createKimiServices, serviceError, type KimiServices } from '@moonshot-ai/testkit/services';

import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import type { Event2 } from '#/app/event/event2';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IHostRequestHeaders } from '#/provider-catalog/model/host-request-headers';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
} from '#/provider-catalog/provider/provider';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import {
  IAgentTitlePromptSource,
  type TitleDigestExcerpt,
  type TitleTurnExcerpt,
} from '#/session/sessionTitle/agentTitlePromptSource';
import { ISessionTitleService } from '#/session/sessionTitle/sessionTitle';
import { SessionTitleService } from '#/session/sessionTitle/sessionTitleService';
import {
  ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { isUntitled } from '#/session/sessionMetadata/promptMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';

import { registerLogServices } from '../../_base/log/stubs';
import { stubProviderService } from '../../app/provider/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

const SESSION_ID = 'sess-1';
const GENERATED_TITLE = '生成的标题';
const MANAGED_OAUTH = { storage: 'file', key: 'kimi-code' } as const;

class FakeEventService implements IEventService {
  declare readonly _serviceBrand: undefined;
  private readonly emitter = new Emitter<Event2>();
  readonly onDidPublish = this.emitter.event;
  readonly published: Event2[] = [];

  publish(event: Event2): void {
    this.published.push(event);
    this.emitter.fire(event);
  }

  subscribe(handler: (event: Event2) => void): IDisposable {
    return this.emitter.event(handler);
  }
}

class FakeSessionMetadata implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  readonly effectiveCwd = '/tmp';
  private readonly emitter = new Emitter<SessionMetadataChangedEvent>();
  readonly onDidChangeMetadata = this.emitter.event;
  meta: SessionMeta;

  constructor() {
    this.meta = {
      id: SESSION_ID,
      createdAt: 0,
      updatedAt: 0,
      archived: false,
    };
  }

  read(): Promise<SessionMeta> {
    return Promise.resolve(this.meta);
  }

  update(patch: SessionMetaPatch): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    this.emitter.fire({ changed: Object.keys(patch) as (keyof SessionMeta)[] });
    return Promise.resolve();
  }

  async applyPromptMetadata(lastPrompt: string, title: string): Promise<boolean> {
    const applyTitle = this.meta.titleKind !== 'custom' && isUntitled(this.meta.title);
    const patch: SessionMetaPatch = applyTitle
      ? { lastPrompt, title, titleKind: 'replaceable' }
      : { lastPrompt };
    await this.update(patch);
    return applyTitle;
  }

  setTitle(title: string): Promise<void> {
    return this.update({ title, titleKind: 'custom' });
  }

  async setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    if (opts?.force !== true && this.meta.titleKind === 'custom') return false;
    await this.update({ title, titleKind: 'generated' });
    return true;
  }

  setArchived(archived: boolean): Promise<void> {
    return this.update({ archived });
  }

  registerAgent(): Promise<void> {
    return Promise.resolve();
  }

  unregisterAgent(): Promise<void> {
    return Promise.resolve();
  }
}

describe('SessionTitleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let events: FakeEventService;
  let metadata: FakeSessionMetadata;
  let telemetry: TelemetryRecord[];
  let providers: Record<string, ProviderConfig>;
  let services: KimiServices;
  let tokenError: Error | undefined;
  let forceTokenError: Error | undefined;
  let resolvedOAuthRefs: Array<OAuthRef | undefined>;
  let titlePrompts: readonly string[];
  let promptSourceImpl: (limit: number) => Promise<readonly string[]>;
  let turnExcerpt: TitleTurnExcerpt;
  let digestExcerpt: TitleDigestExcerpt;
  let tokenCalls: boolean[];

  beforeEach(() => {
    tokenError = undefined;
    forceTokenError = undefined;
    resolvedOAuthRefs = [];
    titlePrompts = [];
    promptSourceImpl = async (limit) => titlePrompts.slice(0, limit);
    turnExcerpt = {};
    digestExcerpt = { turns: [] };
    tokenCalls = [];
    services = createKimiServices();
    vi.stubGlobal('fetch', services.fetch);
    providers = { 'managed:kimi-code': { type: 'kimi', baseUrl: services.baseUrl, oauth: MANAGED_OAUTH } };
    metadata = new FakeSessionMetadata();
    events = new FakeEventService();
    telemetry = [];

    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(
          ISessionContext,
          makeSessionContext({
            sessionId: SESSION_ID,
            workspaceId: 'ws-1',
            sessionDir: '/tmp/sess-1',
            sessionScope: 'sessions/sess-1',
            cwd: '/tmp',
          }),
        );
        reg.defineInstance(ISessionMetadata, metadata);
        const promptSource: IAgentTitlePromptSource = {
          _serviceBrand: undefined,
          firstUserPrompts: (limit) => promptSourceImpl(limit),
          firstTurnExcerpt: async () => turnExcerpt,
          digestExcerpt: async () => digestExcerpt,
        };
        const mainAgent: IAgentScopeHandle = {
          id: MAIN_AGENT_ID,
          kind: LifecycleScope.Agent,
          accessor: { get: <T>() => promptSource as T },
          dispose: () => undefined,
        };
        reg.definePartialInstance(IAgentLifecycleService, {
          handleOf: () => mainAgent,
        });
        reg.defineInstance(IEventService, events);
        reg.defineInstance(IProviderService, stubProviderService(providers));
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider: (_provider, oauthRef) => {
            resolvedOAuthRefs.push(oauthRef);
            return {
              getAccessToken: async (options) => {
                tokenCalls.push(options?.force === true);
                if (tokenError !== undefined) throw tokenError;
                if (options?.force === true && forceTokenError !== undefined) {
                  throw forceTokenError;
                }
                return 'test-token';
              },
            };
          },
        });
        reg.defineInstance(IHostRequestHeaders, {
          headers: { 'User-Agent': 'test' },
          thirdPartyHeaders: {},
        });
        reg.defineInstance(ITelemetryService, recordingTelemetry(telemetry));
        reg.define(ISessionTitleService, SessionTitleService);
      },
    });
    ix.get(ISessionTitleService);
  });

  afterEach(async () => {
    disposables.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await services.close();
    services.verify();
  });

  function titleInput(index = 0): string {
    const body = services.requests('title')[index]?.json as { params: { chat_content: string } } | undefined;
    if (body === undefined) throw new Error(`no title request #${String(index)}`);
    return body.params.chat_content;
  }

  it('replaces the easy title with the generated one', async () => {
    services.title(GENERATED_TITLE);
    titlePrompts = ['帮我看一下这个 Go 的 nil pointer 报错'];

    const title = await ix.get(ISessionTitleService).generateTitle();

    expect(title).toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');

    expect(titleInput()).toBe('user: 帮我看一下这个 Go 的 nil pointer 报错');
    expect(services.requests('title')[0]?.authorization).toBe('Bearer test-token');

    const rebroadcast = events.published.find(
      (event): event is SessionMetaUpdated =>
        event.type === 'session.meta.updated' &&
        (event as SessionMetaUpdated).payload.patch.title === '生成的标题',
    );
    expect(rebroadcast).toBeDefined();
  });

  it('reports a successful generation with timing and title length, not its content', async () => {
    ix.get(ISessionTitleService);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    services.title(GENERATED_TITLE);
    const hold = services.holdNext('title');
    turnExcerpt = { user: '最初的问题', assistant: '第一轮的回答' };

    const generation = ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' });
    await hold.reached();
    now.mockReturnValue(1125);
    hold.release();

    await expect(generation).resolves.toBe('生成的标题');

    expect(telemetry).toEqual([
      {
        event: 'session_title_generation_finished',
        properties: {
          trigger: 'auto',
          source: 'first_turn',
          outcome: 'success',
          duration_ms: 125,
          title_chars: 5,
          title_outcome: 'ok',
        },
      },
    ]);
    expect(JSON.stringify(telemetry)).not.toContain('生成的标题');
  });

  it('reports manual generation and truncation', async () => {
    ix.get(ISessionTitleService);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    digestExcerpt = { turns: [{ user: 'hello', assistant: 'world' }] };
    services.title('x'.repeat(201));

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true, source: 'digest' }),
    ).resolves.toBe('x'.repeat(200));

    expect(telemetry.map((record) => record.properties)).toEqual([
      {
        trigger: 'manual',
        source: 'digest',
        outcome: 'success',
        duration_ms: 0,
        title_chars: 200,
        title_outcome: 'truncated',
      },
    ]);
  });

  it('reports request failures without exposing the error message', async () => {
    titlePrompts = ['hello'];
    services.title(serviceError(500, 'sensitive response'));

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();

    expect(telemetry.map((record) => record.properties)).toEqual([
      {
        trigger: 'auto',
        source: 'user_prompts',
        outcome: 'unavailable',
        reason: 'request_failed',
        duration_ms: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(telemetry)).not.toContain('sensitive response');
  });

  it('reports unexpected errors and preserves their propagation', async () => {
    titlePrompts = ['hello'];
    tokenError = new TypeError('unexpected failure');

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).rejects.toThrow('unexpected failure');

    expect(telemetry.map((record) => record.properties)).toEqual([
      {
        trigger: 'manual',
        source: 'user_prompts',
        outcome: 'error',
        reason: 'unexpected',
        error_type: 'TypeError',
        duration_ms: expect.any(Number),
      },
    ]);
  });

  it('skips telemetry for existing titles and reports when no input is available', async () => {
    await metadata.setTitle('user 取的标题');
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(telemetry).toEqual([]);

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true, source: 'first_turn' }),
    ).resolves.toBeUndefined();
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      event: 'session_title_generation_finished',
      properties: {
        trigger: 'manual',
        source: 'first_turn',
        outcome: 'unavailable',
        reason: 'no_input',
      },
    });
    expect(telemetry[0]!.properties?.['duration_ms']).toEqual(expect.any(Number));
  });

  it('composes the title input from the recorded prompts in order', async () => {
    services.title(GENERATED_TITLE);
    titlePrompts = ['先帮我搭一个 Vite 项目', '加上路由', '现在配一下 ESLint'];

    await ix.get(ISessionTitleService).generateTitle();

    expect(titleInput()).toBe('user: 先帮我搭一个 Vite 项目\nuser: 加上路由\nuser: 现在配一下 ESLint');
  });

  it('truncates each prompt to the per-prompt budget, keeping the head', async () => {
    services.title(GENERATED_TITLE);
    titlePrompts = ['很长的输入'.repeat(400), '第二条'];

    await ix.get(ISessionTitleService).generateTitle();

    expect(titleInput()).toBe(`user: ${'很长的输入'.repeat(80)}\nuser: 第二条`);
  });

  it('returns unavailable when only a slash activation updated lastPrompt', async () => {
    await metadata.update({ lastPrompt: '/compact' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(services.requests()).toEqual([]);
  });

  it('does nothing without a managed OAuth provider', async () => {
    delete providers['managed:kimi-code'];
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(services.requests()).toEqual([]);
  });

  it('never overwrites a custom title set while generation is in flight', async () => {
    services.title(GENERATED_TITLE);
    const hold = services.holdNext('title');

    titlePrompts = ['hello'];
    const generation = ix.get(ISessionTitleService).generateTitle();
    await hold.reached();
    await metadata.setTitle('user 取的标题');
    hold.release();

    await expect(generation).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('user 取的标题');
    expect(metadata.meta.titleKind).toBe('custom');
  });

  it('skips generation when the current title was already generated', async () => {
    await metadata.setGeneratedTitleIfUncustomized('已生成的标题');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(services.requests()).toEqual([]);
    expect(metadata.meta.title).toBe('已生成的标题');
  });

  it('force regenerates an already-generated title', async () => {
    services.title(GENERATED_TITLE);
    await metadata.setGeneratedTitleIfUncustomized('已生成的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBe('生成的标题');
    expect(services.requests('title')).toHaveLength(1);
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');
  });

  it('force overwrites a custom title and drops its custom marking', async () => {
    services.title(GENERATED_TITLE);
    await metadata.setTitle('user 取的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');
  });

  it('force still degrades when the backend request fails', async () => {
    services.title(serviceError(500));
    await metadata.setTitle('user 取的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('user 取的标题');
    expect(metadata.meta.titleKind).toBe('custom');
  });

  it('first_turn composes the opening prompt with the first reply, within budget', async () => {
    services.title(GENERATED_TITLE);
    turnExcerpt = { user: '最初的问题', assistant: '第一轮的回答' };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBe('生成的标题');

    expect(titleInput()).toBe('user: 最初的问题\nassistant: 第一轮的回答');
  });

  it('first_turn is strict: no assistant reply yet means unavailable', async () => {
    turnExcerpt = { user: '只有问题' };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBeUndefined();
    expect(services.requests()).toEqual([]);
  });

  it('first_turn truncates each segment to its budget', async () => {
    services.title(GENERATED_TITLE);
    turnExcerpt = { user: '问'.repeat(500), assistant: '答'.repeat(1000) };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBe('生成的标题');

    expect(titleInput()).toBe(`user: ${'问'.repeat(400)}\nassistant: ${'答'.repeat(300)}`);
  });

  it('digest composes every turn as interleaved user/assistant lines', async () => {
    services.title(GENERATED_TITLE, GENERATED_TITLE);
    digestExcerpt = {
      turns: [
        { user: '开场', assistant: '开场回答' },
        { user: '最新追问', assistant: '当前进展' },
      ],
    };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBe('生成的标题');

    expect(titleInput(0)).toBe('user: 开场\nassistant: 开场回答\nuser: 最新追问\nassistant: 当前进展');

    digestExcerpt = { turns: [{ user: '开场', assistant: undefined }] };
    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true, source: 'digest' }),
    ).resolves.toBe('生成的标题');
    expect(titleInput(1)).toBe('user: 开场');
  });

  it('digest truncates each segment to its budget', async () => {
    services.title(GENERATED_TITLE);
    digestExcerpt = {
      turns: [{ user: '问'.repeat(300), assistant: '答'.repeat(300) }],
    };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBe('生成的标题');

    expect(titleInput()).toBe(`user: ${'问'.repeat(200)}\nassistant: ${'答'.repeat(200)}`);
  });

  it('digest elides the middle turns when the input exceeds the total budget', async () => {
    services.title(GENERATED_TITLE);
    digestExcerpt = {
      turns: Array.from({ length: 30 }, (_, i) => ({
        user: `第${i}个${'问'.repeat(180)}`,
        assistant: `第${i}个${'答'.repeat(180)}`,
      })),
    };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBe('生成的标题');

    const content = titleInput();
    expect(content.length).toBeLessThanOrEqual(3000);
    expect(content.startsWith('user: 第0个')).toBe(true);
    expect(content).toContain('\n...\n');
    expect(content.split('\n...\n')[1]?.startsWith('user: ')).toBe(true);
    expect(content.endsWith(`assistant: 第29个${'答'.repeat(180)}`)).toBe(true);
  });

  it('digest is unavailable when the window yields no segments at all', async () => {
    digestExcerpt = { turns: [] };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBeUndefined();
    expect(services.requests()).toEqual([]);
  });

  it('keeps the current title when the backend request fails', async () => {
    services.title(serviceError(500));
    titlePrompts = ['hello'];
    await metadata.update({ title: 'hello', titleKind: 'replaceable' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('hello');
    expect(tokenCalls).toEqual([false]);
  });

  it('retries once with a force-refreshed token on a 401', async () => {
    services.title(serviceError(401), GENERATED_TITLE);
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(services.requests('title')).toHaveLength(2);
    expect(tokenCalls).toEqual([false, true]);
  });

  it('gives up when the 401 persists after the force refresh', async () => {
    services.title(serviceError(401), serviceError(401));
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBeUndefined();
    expect(services.requests('title')).toHaveLength(2);
    expect(tokenCalls).toEqual([false, true]);
  });

  it('degrades when the force refresh after a 401 fails', async () => {
    services.title(serviceError(401));
    forceTokenError = new OAuthUnauthorizedError('refresh rejected');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBeUndefined();
    expect(services.requests('title')).toHaveLength(1);
    expect(tokenCalls).toEqual([false, true]);
  });

  it('returns unavailable when the OAuth token is missing or revoked', async () => {
    tokenError = new OAuthUnauthorizedError('re-login required');
    titlePrompts = ['hello'];

    const svc = ix.get(ISessionTitleService);
    await expect(svc.generateTitle()).resolves.toBeUndefined();
    expect(services.requests()).toEqual([]);
  });

  it('returns unavailable when OAuth token retrieval has an operational failure', async () => {
    tokenError = new OAuthConnectionError('connection failed');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(services.requests()).toEqual([]);
  });

  it('propagates unexpected token provider failures', async () => {
    tokenError = new Error('unexpected failure');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).rejects.toThrow(
      'unexpected failure',
    );
    expect(services.requests()).toEqual([]);
  });

  it('includes environment custom headers', async () => {
    services.title(GENERATED_TITLE);
    vi.stubEnv('KIMI_CODE_CUSTOM_HEADERS', 'X-Proxy-Header: from-env\n');
    titlePrompts = ['hello'];

    await ix.get(ISessionTitleService).generateTitle();

    const headers = services.requests('title')[0]?.headers;
    expect(headers?.['x-proxy-header']).toBe('from-env');
    expect(headers?.['user-agent']).toBe('test');
  });

  it('pairs the environment endpoint with its credential slot when it overrides persisted config', async () => {
    services.title(GENERATED_TITLE);
    vi.stubEnv('KIMI_CODE_BASE_URL', `${services.origin}/from-env/coding/v1`);
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.env.example.test');
    titlePrompts = ['hello'];

    await ix.get(ISessionTitleService).generateTitle();

    expect(services.requests('title')[0]?.path.startsWith('/from-env/')).toBe(true);
    expect(resolvedOAuthRefs[0]).toMatchObject({
      storage: 'file',
      oauthHost: 'https://auth.env.example.test',
    });
    expect(resolvedOAuthRefs[0]?.key).not.toBe(MANAGED_OAUTH.key);
  });

  it('shares an in-flight generation between concurrent requests', async () => {
    services.title(GENERATED_TITLE);
    const hold = services.holdNext('title');

    titlePrompts = ['hello'];
    const first = ix.get(ISessionTitleService).generateTitle();
    const second = ix.get(ISessionTitleService).generateTitle();
    await hold.reached();

    hold.release();
    await expect(first).resolves.toBe('生成的标题');
    await expect(second).resolves.toBe('生成的标题');
    expect(services.requests('title')).toHaveLength(1);
  });

  it('returns unavailable without calling the backend when no prompt was seen', async () => {
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(services.requests()).toEqual([]);
  });
});
