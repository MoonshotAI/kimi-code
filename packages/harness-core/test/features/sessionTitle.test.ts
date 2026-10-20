import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import {
  createAssistantEntry,
  createUserEntry,
  emptyUsage,
  type AssistantEntry,
  type HistoryMessage,
  type UserEntry,
  type UserMeta,
} from '@moonshot-ai/agent-core/history/index';
import { useExpose, useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage } from '@moonshot-ai/agent-core/llm/message';
import { MAIN_AGENT_ID, type Agent } from '@moonshot-ai/agent-core/session/index';
import {
  FileTokenStorage,
  OAuthError,
  resolveKimiCodeOAuthKey,
  resolveKimiTokenStorageName,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';

import { createConfig, type ConfigPersist } from '#/features/config/index';
import { createOauth, OAuthTokensRef, type OAuthTokens } from '#/features/kimi/oauth/index';
import {
  composeTitleInput,
  sessionTitle,
  SessionTitleRef,
  type SessionTitleFace,
} from '#/features/kimi/sessionTitle/index';
import { providerCatalog } from '#/features/provider-catalog/index';
import { createHarness, memoryHarnessSpace, type Harness } from '#/runtime/index';

const MANAGED_PROVIDER_TOML =
  '[providers."managed:kimi-code"]\n' +
  'type = "kimi"\n' +
  'base_url = "https://managed.example.com"\n' +
  'model_source = "oauth-catalog"\n\n' +
  '[providers."managed:kimi-code".oauth]\n' +
  'storage = "file"\n' +
  'key = "oauth/kimi-code"\n';

const MANAGED_PROVIDER_LEGACY_TOML =
  '[providers."managed:kimi-code"]\n' +
  'type = "kimi"\n' +
  'base_url = "https://managed.example.com"\n' +
  'api_key = ""\n' +
  'alias_scope = "kimi-code"\n\n' +
  '[providers."managed:kimi-code".oauth]\n' +
  'storage = "file"\n' +
  'key = "oauth/kimi-code"\n';

const ENV_KEYS = ['KIMI_CODE_BASE_URL', 'KIMI_CODE_OAUTH_HOST', 'KIMI_OAUTH_HOST'] as const;

const savedEnv = new Map<string, string | undefined>();

const homes: string[] = [];

const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setupHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'harness-title-'));
  homes.push(home);
  const oauthKey = resolveKimiCodeOAuthKey({ baseUrl: 'https://managed.example.com' });
  await new FileTokenStorage(join(home, 'credentials')).save(
    resolveKimiTokenStorageName({ oauthKey }),
    {
      accessToken: 'sk-managed',
      refreshToken: 'refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scope: '',
      tokenType: 'Bearer',
      expiresIn: 3600,
    },
  );
  return home;
}

function fakePersist(initial?: string): ConfigPersist {
  let text = initial;
  return {
    load: () => Promise.resolve(text),
    save: (value) => {
      text = value;
      return Promise.resolve();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function userEntry(text: string, meta?: UserMeta): UserEntry {
  return createUserEntry(createUserMessage(text), { origin: { kind: 'user' }, ...meta });
}

function assistantEntry(text: string): AssistantEntry {
  return createAssistantEntry(createAssistantMessage([{ type: 'text', text }]), {
    usage: emptyUsage(),
  });
}

interface TitleCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly chatContent?: string;
}

let respond: (call: TitleCall) => Response | Promise<Response>;

function stubTitleFetch(): TitleCall[] {
  const calls: TitleCall[] = [];
  respond = () => Response.json({ title: '生成标题' });
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://managed.example.com/')) {
      return realFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method?: string;
      params?: { chat_content?: string };
    };
    const call: TitleCall = {
      url,
      authorization: headers.get('Authorization'),
      chatContent: body.params?.chat_content,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch);
  return calls;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

function stubOAuthTokens(tokens: BearerTokenProvider | undefined): OAuthTokens {
  const unavailable = (): never => {
    throw new Error('not available in test stub');
  };
  return {
    resolve: () => tokens,
    refresh: () => Promise.resolve({ changed: [], unchanged: [], failed: [] }),
    loginStart: unavailable,
    loginStatus: unavailable,
    loginCancel: unavailable,
    logout: unavailable,
    usage: unavailable,
    userinfo: unavailable,
    region: unavailable,
    summary: unavailable,
  };
}

interface TitleSession {
  readonly harness: Harness;
  readonly main: Agent;
  readonly face: SessionTitleFace;
}

async function openTitleSession(options: {
  toml?: string;
  home?: string;
  tokens?: BearerTokenProvider;
}): Promise<TitleSession> {
  const capture: { title?: Readonly<ShallowRef<SessionTitleFace | undefined>> } = {};
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(createConfig({ persist: fakePersist(options.toml ?? MANAGED_PROVIDER_TOML) }));
  harness.app.features.add(providerCatalog);
  if (options.home !== undefined) {
    harness.app.features.add(createOauth({ home: options.home }));
  } else {
    const tokens = options.tokens;
    harness.app.features.add(
      createFeature('test-oauth', {
        app() {
          useExpose(OAuthTokensRef, stubOAuthTokens(tokens));
        },
      }),
    );
  }
  harness.app.features.add(sessionTitle);
  harness.app.features.add(
    createFeature('probe', {
      session() {
        capture.title = useInject(SessionTitleRef);
      },
    }),
  );
  await tick();
  const session = await harness.app.create({ sessionId: 'sess' });
  const main = await harness.ensureAgent(session, MAIN_AGENT_ID);
  await tick();
  const face = capture.title?.value;
  if (face === undefined) throw new Error('sessionTitle face was not exposed');
  return { harness, main, face };
}

async function seedPrompts(main: Agent, ...entries: HistoryMessage[]): Promise<void> {
  main.loop.setContext(entries);
  await main.flush();
}

describe('sessionTitle excerpt', () => {
  it('composes user_prompts with filtering, dedupe and skill stripping', () => {
    const skillBundled: UserEntry = createUserEntry(
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'SKILL BODY',
            meta: { kind: 'skill', activationId: 'act-1', skillName: 'demo' },
          },
          { type: 'text', text: 'second prompt' },
        ],
      },
      { origin: { kind: 'user' } },
    );
    const history: HistoryMessage[] = [
      userEntry('first prompt'),
      userEntry('not natural', { origin: { kind: 'reminder' } }),
      skillBundled,
      userEntry('dup', { userMessageId: 'm-1' }),
      userEntry('dup', { userMessageId: 'm-1' }),
      userEntry('compacted summary', { source: 'compaction', key: 'summary', origin: undefined }),
      userEntry('fourth prompt'),
    ];
    expect(composeTitleInput(history, 'user_prompts')).toBe(
      'user: first prompt\nuser: second prompt\nuser: dup',
    );
    expect(composeTitleInput([], 'user_prompts')).toBeUndefined();
    expect(
      composeTitleInput([userEntry('my api_key=sk-abcdef1234567890 leaked')], 'user_prompts'),
    ).toBe('user: my api_key=[redacted] leaked');
  });

  it('truncates user_prompts segments to 400 chars and the whole input to 1000', () => {
    const history: HistoryMessage[] = [
      userEntry('甲'.repeat(500)),
      userEntry('乙'.repeat(500)),
      userEntry('丙'.repeat(500)),
    ];
    const input = composeTitleInput(history, 'user_prompts');
    expect(input).toBeDefined();
    expect(input).toHaveLength(1000);
    expect(input!.startsWith(`user: ${'甲'.repeat(400)}\nuser: ${'乙'.repeat(400)}\nuser: `)).toBe(
      true,
    );
    expect(input!.endsWith('丙'.repeat(180))).toBe(true);
  });

  it('composes first_turn within budget and stays strict without an assistant reply', () => {
    const history: HistoryMessage[] = [
      userEntry('问'.repeat(500)),
      assistantEntry('答'.repeat(500)),
      userEntry('next turn'),
      assistantEntry('later reply'),
    ];
    expect(composeTitleInput(history, 'first_turn')).toBe(
      `user: ${'问'.repeat(400)}\nassistant: ${'答'.repeat(300)}`,
    );
    expect(composeTitleInput([userEntry('hello')], 'first_turn')).toBeUndefined();
  });

  it('composes digest turns and elides the middle turns when over budget', () => {
    const small: HistoryMessage[] = [
      userEntry('q1'),
      assistantEntry('a1'),
      userEntry('q2'),
    ];
    expect(composeTitleInput(small, 'digest')).toBe('user: q1\nassistant: a1\nuser: q2');

    const history: HistoryMessage[] = [];
    for (let index = 0; index < 10; index++) {
      history.push(userEntry(`第${index}问${'文'.repeat(200)}`));
      history.push(assistantEntry(`第${index}答${'复'.repeat(200)}`));
    }
    const input = composeTitleInput(history, 'digest');
    expect(input).toBeDefined();
    expect(input!.length).toBeLessThanOrEqual(3000);
    const parts = input!.split('\n...\n');
    expect(parts).toHaveLength(2);
    expect(parts[0]!.startsWith('user: 第0问')).toBe(true);
    expect(parts[0]!.includes('assistant: 第0答')).toBe(true);
    expect(parts[1]!.startsWith('user: 第4问')).toBe(true);
    expect(parts[1]!.endsWith(`assistant: 第9答${'复'.repeat(197)}`)).toBe(true);
  });
});

describe('sessionTitle facade', () => {
  it('generates a title through the managed chat_title tool and records it as generated', async () => {
    const home = await setupHome();
    const calls = stubTitleFetch();
    const { harness, main, face } = await openTitleSession({ home });
    await seedPrompts(main, userEntry('hello title'));

    const title = await face.generateTitle();
    expect(title).toBe('生成标题');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://managed.example.com/tools');
    expect(calls[0]?.authorization).toBe('Bearer sk-managed');
    expect(calls[0]?.chatContent).toBe('user: hello title');
    const record = await harness.app.space.get('sess');
    expect(record?.title).toBe('生成标题');
    expect(record?.metadata?.['titleKind']).toBe('generated');

    respond = () => Response.json({ title: '题'.repeat(300) });
    const forced = await face.generateTitle({ force: true });
    expect(forced).toBe('题'.repeat(200));
    expect((await harness.app.space.get('sess'))?.title).toBe('题'.repeat(200));
    await harness.close();
  });

  it('generates a title when the provider entry carries oauth without model_source', async () => {
    const calls = stubTitleFetch();
    const tokens: BearerTokenProvider = { getAccessToken: () => Promise.resolve('sk-managed') };
    const { harness, main, face } = await openTitleSession({
      toml: MANAGED_PROVIDER_LEGACY_TOML,
      tokens,
    });
    await seedPrompts(main, userEntry('hello title'));

    const title = await face.generateTitle();
    expect(title).toBe('生成标题');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://managed.example.com/tools');
    expect(calls[0]?.authorization).toBe('Bearer sk-managed');
    expect((await harness.app.space.get('sess'))?.title).toBe('生成标题');
    await harness.close();
  });

  it('early-exits on custom or generated titles and force overwrites custom', async () => {
    const calls = stubTitleFetch();
    const tokens: BearerTokenProvider = { getAccessToken: () => Promise.resolve('fresh-token') };
    const { harness, main, face } = await openTitleSession({ tokens });
    await seedPrompts(main, userEntry('hello title'));

    await harness.app.update('sess', { title: '手写标题', metadata: { titleKind: 'custom' } });
    expect(await face.generateTitle()).toBeUndefined();
    expect(calls).toHaveLength(0);

    expect(await face.generateTitle({ force: true })).toBe('生成标题');
    expect(calls).toHaveLength(1);
    const record = await harness.app.space.get('sess');
    expect(record?.title).toBe('生成标题');
    expect(record?.metadata?.['titleKind']).toBe('generated');

    expect(await face.generateTitle()).toBeUndefined();
    expect(calls).toHaveLength(1);
    await harness.close();
  });

  it('never overwrites a custom title set while generation is in flight', async () => {
    const calls = stubTitleFetch();
    const gate = deferred<Response>();
    respond = () => gate.promise;
    const tokens: BearerTokenProvider = { getAccessToken: () => Promise.resolve('fresh-token') };
    const { harness, main, face } = await openTitleSession({ tokens });
    await seedPrompts(main, userEntry('hello title'));

    const pending = face.generateTitle();
    await until(() => calls.length === 1);
    await harness.app.update('sess', { title: '手写标题', metadata: { titleKind: 'custom' } });
    gate.resolve(Response.json({ title: '生成标题' }));
    expect(await pending).toBeUndefined();
    const record = await harness.app.space.get('sess');
    expect(record?.title).toBe('手写标题');
    expect(record?.metadata?.['titleKind']).toBe('custom');
    await harness.close();
  });

  it('shares an in-flight generation and clears it after settle', async () => {
    const calls = stubTitleFetch();
    const gate = deferred<Response>();
    respond = () => gate.promise;
    const tokens: BearerTokenProvider = { getAccessToken: () => Promise.resolve('fresh-token') };
    const { main, face, harness } = await openTitleSession({ tokens });
    await seedPrompts(main, userEntry('hello title'));

    const first = face.generateTitle();
    const second = face.generateTitle();
    expect(second).toBe(first);
    const forced = face.generateTitle({ force: true });
    await until(() => calls.length === 2);
    gate.resolve(new Response('backend down', { status: 500 }));
    expect(await first).toBeUndefined();
    expect(await forced).toBeUndefined();

    respond = () => Response.json({ title: '重试标题' });
    expect(await face.generateTitle()).toBe('重试标题');
    expect(calls).toHaveLength(3);
    expect(await face.generateTitle()).toBeUndefined();
    expect(calls).toHaveLength(3);
    await harness.close();
  });

  it('retries once with a force-refreshed token on a 401 and gives up when it persists', async () => {
    const calls = stubTitleFetch();
    const forceCalls: boolean[] = [];
    const tokens: BearerTokenProvider = {
      getAccessToken: (options) => {
        const force = options?.force === true;
        forceCalls.push(force);
        return Promise.resolve(force ? 'fresh-token' : 'stale-token');
      },
    };
    let failures = 1;
    respond = () => {
      failures -= 1;
      return failures < 0
        ? Response.json({ title: '重试标题' })
        : new Response('unauthorized', { status: 401 });
    };
    const first = await openTitleSession({ tokens });
    await seedPrompts(first.main, userEntry('hello title'));
    expect(await first.face.generateTitle()).toBe('重试标题');
    expect(forceCalls).toEqual([false, true]);
    expect(calls[0]?.authorization).toBe('Bearer stale-token');
    expect(calls[1]?.authorization).toBe('Bearer fresh-token');
    await first.harness.close();

    const second = await openTitleSession({ tokens });
    await seedPrompts(second.main, userEntry('hello title'));
    respond = () => new Response('unauthorized', { status: 401 });
    expect(await second.face.generateTitle()).toBeUndefined();
    expect(calls).toHaveLength(4);
    await second.harness.close();
  });

  it('degrades on OAuthError and propagates unexpected token failures', async () => {
    const calls = stubTitleFetch();
    const revoked: BearerTokenProvider = {
      getAccessToken: () => Promise.reject(new OAuthError('revoked')),
    };
    const first = await openTitleSession({ tokens: revoked });
    await seedPrompts(first.main, userEntry('hello title'));
    expect(await first.face.generateTitle()).toBeUndefined();
    expect(calls).toHaveLength(0);
    await first.harness.close();

    const refreshFails: BearerTokenProvider = {
      getAccessToken: (options) =>
        options?.force === true
          ? Promise.reject(new OAuthError('refresh rejected'))
          : Promise.resolve('stale-token'),
    };
    respond = () => new Response('unauthorized', { status: 401 });
    const second = await openTitleSession({ tokens: refreshFails });
    await seedPrompts(second.main, userEntry('hello title'));
    expect(await second.face.generateTitle()).toBeUndefined();
    expect(calls).toHaveLength(1);
    await second.harness.close();

    const broken: BearerTokenProvider = {
      getAccessToken: () => Promise.reject(new TypeError('boom')),
    };
    const third = await openTitleSession({ tokens: broken });
    await seedPrompts(third.main, userEntry('hello title'));
    await expect(third.face.generateTitle()).rejects.toThrow('boom');
    await third.harness.close();
  });

  it('returns undefined without a managed oauth provider or a resolvable token', async () => {
    const calls = stubTitleFetch();
    const tokens: BearerTokenProvider = { getAccessToken: () => Promise.resolve('fresh-token') };

    const noProvider = await openTitleSession({ toml: '', tokens });
    await seedPrompts(noProvider.main, userEntry('hello title'));
    expect(await noProvider.face.generateTitle()).toBeUndefined();
    await noProvider.harness.close();

    const staticProvider = await openTitleSession({
      toml: '[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "https://managed.example.com"\n',
      tokens,
    });
    await seedPrompts(staticProvider.main, userEntry('hello title'));
    expect(await staticProvider.face.generateTitle()).toBeUndefined();
    await staticProvider.harness.close();

    const noToken = await openTitleSession({});
    await seedPrompts(noToken.main, userEntry('hello title'));
    expect(await noToken.face.generateTitle()).toBeUndefined();
    await noToken.harness.close();
    expect(calls).toHaveLength(0);
  });
});
