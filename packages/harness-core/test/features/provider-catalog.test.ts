import { parse as parseToml } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import {
  createFeature,
  createApp,
  type App,
  type EnsuredAgent,
} from '#/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { memorySessionSpace } from '@moonshot-ai/agent-core/session/index';
import { useCollection, useInject, watch, type ComputedRef, type ShallowRef } from '#/kernel/index';
import { anthropicRequester, openAIRequester } from '@moonshot-ai/agent-core/llm/builtin/provider/index';
import { createAssistantMessage, createUserMessage } from '@moonshot-ai/agent-core/llm/message';
import type {
  LlmCredentialProvider,
  LlmEndpoint,
  LlmModelSpec,
  LlmRequest,
  LlmRequestModel,
  ThinkingRequestOptions,
} from '@moonshot-ai/agent-core/llm/request';
import { mergeFields } from '@moonshot-ai/agent-core/llm/requester';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { Log } from '@moonshot-ai/agent-core/store/index';

import {
  ENV_MODEL_PROVIDER_KEY,
  createConfig,
  useConfig,
  type ConfigPersist,
  type ConfigStore,
} from '#/todo-features/config/index';
import {
  AgentModelRef,
  CatalogModels,
  CredentialResolvers,
  ENV_MODEL_ALIAS_KEY,
  ModelDefaultsRef,
  SESSION_MODEL_DEFAULTS,
  SessionModelRef,
  matchCatalogBinding,
  providerCatalog,
  resolveCredentialProvider,
  sessionModelDefaultsProjection,
  useCredentialResolver,
  useProvider,
  useProviderCatalog,
  useProviderProtocol,
  useProviderRefresh,
  type AgentModelFace,
  type CatalogModelBinding,
  type CatalogModelConfig,
  type CatalogModelRecords,
  type CatalogProviderHandle,
  type ModelDefaultsFace,
  type ProviderCatalogFace,
  type SessionModelDefaults,
  type SessionModelDefaultsEvent,
  type SessionModelFace,
} from '#/features/provider-catalog/index';
import { type AgentRuntime } from '#/runtime/index';

type Fields = Record<string, unknown>;

function fakeRequester(next: (rest: Fields) => LlmOutcome | Promise<LlmOutcome>): LoopLlmRequester {
  const make = (filled: Fields): LoopLlmRequester => ({
    with: (part) => make(mergeFields(filled, part as Fields) ?? {}),
    request: (rest) => mergeFields(filled, rest as Fields) as unknown as LlmRequest,
    generate: async (rest) => next(mergeFields(filled, rest as Fields) ?? {}),
  });
  return make({});
}

function textOutcome(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

function failedOutcome(message: string): LlmOutcome {
  return { type: 'failed', error: { kind: 'unknown', message } };
}

function failingRequester(message: string): LoopLlmRequester {
  return fakeRequester(() => failedOutcome(message));
}

function testCapability(thinking: boolean): NonNullable<CatalogModelConfig['capability']> {
  return { image_in: false, video_in: false, audio_in: false, thinking, tool_use: true };
}

const modelDef: CatalogModelConfig = {
  provider: 'test',
  model: 'm1',
  capability: testCapability(false),
  maxContextSize: 4096,
};

function stubHandle(
  id: string,
  requester: CatalogProviderHandle['requester'],
): CatalogProviderHandle {
  return { id, requester };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await tick();
  }
  expect(predicate()).toBe(true);
}

function fakePersist(initial?: string): { saved: string[]; persist: ConfigPersist } {
  const saved: string[] = [];
  let text = initial;
  return {
    saved,
    persist: {
      load: () => Promise.resolve(text),
      save: (value) => {
        saved.push(value);
        text = value;
        return Promise.resolve();
      },
    },
  };
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

interface ProbeCapture {
  catalog?: Readonly<ShallowRef<ProviderCatalogFace | undefined>>;
  config?: Readonly<ShallowRef<ConfigStore | undefined>>;
  defaults?: Readonly<ShallowRef<ModelDefaultsFace | undefined>>;
  models?: ComputedRef<readonly CatalogModelBinding[]>;
  credentials?: ComputedRef<readonly import('#/features/provider-catalog/index').CredentialResolverContribution[]>;
  sessionFace?: SessionModelFace;
  agentFace?: AgentModelFace;
}

function catalogProbe(capture: ProbeCapture, contribute?: () => void) {
  return createFeature('probe', {
    app() {
      capture.catalog = useProviderCatalog();
      capture.config = useConfig();
      capture.defaults = useInject(ModelDefaultsRef);
      capture.models = useCollection(CatalogModels);
      capture.credentials = useCollection(CredentialResolvers);
      contribute?.();
    },
    session() {
      const face = useInject(SessionModelRef);
      watch(
        face,
        (value) => {
          capture.sessionFace = value;
        },
        { immediate: true },
      );
    },
    agent() {
      const face = useInject(AgentModelRef);
      watch(
        face,
        (value) => {
          capture.agentFace = value;
        },
        { immediate: true },
      );
    },
  });
}

async function mountCatalog(contribute?: () => void): Promise<{
  harness: App;
  catalog: ProviderCatalogFace;
  models: () => readonly CatalogModelBinding[];
}> {
  const capture: ProbeCapture = {};
  const harness = createApp({ space: memorySessionSpace() });
  harness.features.add(providerCatalog);
  harness.features.add(createConfig({ persist: fakePersist().persist }));
  harness.features.add(catalogProbe(capture, contribute));
  await tick();
  const catalog = capture.catalog?.value;
  if (catalog === undefined) throw new Error('provider catalog face was not exposed');
  return { harness, catalog, models: () => capture.models?.value ?? [] };
}

async function mountWithConfig(
  initial: string | undefined,
  options: { env?: Record<string, string>; contribute?: () => void } = {},
): Promise<{
  harness: App;
  file: { saved: string[]; persist: ConfigPersist };
  config: ConfigStore;
  catalog: ProviderCatalogFace;
  capture: ProbeCapture;
  models: () => readonly CatalogModelBinding[];
}> {
  const file = fakePersist(initial);
  const capture: ProbeCapture = {};
  const harness = createApp({ space: memorySessionSpace() });
  harness.features.add(providerCatalog);
  harness.features.add(createConfig({ persist: file.persist, env: options.env }));
  harness.features.add(catalogProbe(capture, options.contribute));
  await tick();
  const config = capture.config?.value;
  const catalog = capture.catalog?.value;
  if (config === undefined || catalog === undefined) {
    throw new Error('config or catalog face was not exposed');
  }
  await config.reload();
  return { harness, file, config, catalog, capture, models: () => capture.models?.value ?? [] };
}

function runtimeOf(harness: App, sessionId: string, agentId: string): AgentRuntime {
  const session = harness.sessions.get(sessionId);
  const runtime =
    session !== undefined
      ? session.agentRuntime(agentId)
      : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  return runtime;
}

function boundModel(
  harness: App,
  sessionId: string,
  agentId: string,
): {
  spec?: LlmModelSpec;
  thinking?: ThinkingRequestOptions;
  sampling?: LlmRequestModel['sampling'];
  maxOutputTokens?: LlmRequestModel['maxOutputTokens'];
} {
  const request = runtimeOf(harness, sessionId, agentId).requester?.request({
    content: { messages: [] },
  });
  const model = request?.model as LlmRequestModel | undefined;
  return {
    spec: model?.spec,
    thinking: model?.thinking,
    sampling: model?.sampling,
    maxOutputTokens: model?.maxOutputTokens,
  };
}

function sessionDefaultsLog(harness: App, sessionId: string): Log<SessionModelDefaultsEvent> {
  const session = harness.sessions.get(sessionId);
  if (session === undefined) throw new Error(`session '${sessionId}' is not open`);
  return session.log as unknown as Log<SessionModelDefaultsEvent>;
}

async function writeSessionDefaults(
  harness: App,
  sessionId: string,
  patch: { defaultModel?: string; defaultThinking?: string },
): Promise<void> {
  await sessionDefaultsLog(harness, sessionId).commit({
    events: [
      {
        type: SESSION_MODEL_DEFAULTS,
        defaultModel: patch.defaultModel,
        defaultThinking: patch.defaultThinking,
      },
    ],
  });
}

async function sessionDefaultsState(
  harness: App,
  sessionId: string,
): Promise<SessionModelDefaults> {
  const view = sessionDefaultsLog(harness, sessionId).replica.view(sessionModelDefaultsProjection);
  const state = view.getState();
  view.dispose();
  return state;
}

describe('providerCatalog feature', () => {
  it('contributes a provider, adds a model, and exposes a requester binding', async () => {
    let failing = true;
    const requester = fakeRequester(() => (failing ? failedOutcome('boom') : textOutcome('pong')));
    const { harness, catalog, models } = await mountCatalog(() => {
      useProvider({ handle: stubHandle('test', requester) });
    });
    await Promise.all([
      catalog.addModel('test/m1', modelDef),
      catalog.addModel('test/m2', { ...modelDef, model: 'm2' }),
    ]);
    await until(() => catalog.models('test').length === 2);
    await until(() => models().some((item) => item.model.id === 'm1'));
    expect(catalog.requester('test', 'm1')).toBeDefined();

    const failed = await catalog.ping('test', 'm1');
    expect(failed).toMatchObject({ ok: false, error: 'boom' });
    expect(failed.durationMs).toEqual(expect.any(Number));
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');

    failing = false;
    const succeeded = await catalog.ping('test', 'm1');
    expect(succeeded).toMatchObject({ ok: true, text: 'pong' });
    expect(succeeded.durationMs).toEqual(expect.any(Number));
    await until(() => catalog.models('test').at(0)?.pingError === undefined);
    await harness.close();
  });

  it('rejects pings for unknown providers and models', async () => {
    const { harness, catalog } = await mountCatalog();
    await catalog.addProvider({ handle: stubHandle('test', failingRequester('boom')) });
    await catalog.addModel('test/m1', modelDef);
    await until(() => catalog.models('test').length === 1);

    await expect(catalog.ping('nope', 'm1')).rejects.toThrow('Unknown model nope/m1');
    await expect(catalog.ping('test', 'nope')).rejects.toThrow('Unknown model test/nope');

    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();
    expect(catalog.requester('nope', 'm1')).toBeUndefined();
    await harness.close();
  });

  it('pings through the latest provider instance after adding it again', async () => {
    const { harness, catalog } = await mountCatalog();
    await catalog.addProvider({ handle: stubHandle('test', failingRequester('first')) });
    await catalog.addProvider({ handle: stubHandle('test', failingRequester('second')) });
    await catalog.addModel('test/m1', modelDef);
    await until(() => catalog.models('test').length === 1);

    await expect(catalog.ping('test', 'm1')).resolves.toMatchObject({ ok: false, error: 'second' });

    await until(() => catalog.models('test').at(0)?.pingError === 'second');
    expect(catalog.requester('test', 'm1')).toBeDefined();
    await harness.close();
  });

  it('keeps model protocol flags on the definition and selects the protocol requester', async () => {
    const seen: (LlmModelSpec | undefined)[] = [];
    const requester = fakeRequester((rest) => {
      seen.push((rest['model'] as LlmRequestModel | undefined)?.spec);
      return textOutcome('pong');
    });
    const handle: CatalogProviderHandle = {
      id: 'test',
      requester: { anthropic: requester },
    };
    const { harness, catalog } = await mountCatalog();
    await catalog.addProvider({ handle });
    await catalog.addModel('test/m1', { ...modelDef, protocol: 'anthropic', betaApi: true });

    await expect(catalog.ping('test', 'm1')).resolves.toMatchObject({ ok: true, text: 'pong' });
    await until(() => seen.length > 0);
    expect(seen[0]?.name).toBe('m1');
    expect(catalog.models('test').at(0)?.protocolOptions?.['betaApi']).toBe(true);
    expect(catalog.requester('test', 'm1')).toBeDefined();
    await harness.close();
  });

  it('refreshes through contributions, preserves empty results, and serializes reports', async () => {
    let upstream: CatalogModelRecords = { 'test/m1': modelDef };
    let offline = false;
    let pause: Promise<void> | undefined;
    const { harness, catalog } = await mountCatalog(() => {
      useProvider({
        handle: stubHandle('test', failingRequester('boom')),
        info: { type: 'test-refresh' },
      });
      useProviderRefresh({
        match: (info) => info.type === 'test-refresh',
        refresh: async () => {
          if (offline) throw new Error('offline');
          const result = upstream;
          const wait = pause;
          pause = undefined;
          if (wait !== undefined) await wait;
          return result;
        },
      });
    });
    const changed: unknown[] = [];
    const failures: unknown[] = [];
    harness.on(providerCatalog, 'event.model_catalog.changed', (event) => {
      changed.push(event.payload);
    });
    catalog.onRefreshFailed((event) => {
      failures.push(event);
    });

    const first = await catalog.refresh({ providerId: 'test' });
    expect(first).toEqual({
      changed: [{ provider_id: 'test', provider_name: 'test', added: 1, removed: 0 }],
      unchanged: [],
      failed: [],
    });
    await until(() => catalog.models('test').length === 1);

    upstream = {};
    const empty = await catalog.refresh({ providerId: 'test' });
    expect(empty).toEqual({ changed: [], unchanged: ['test'], failed: [] });
    expect(catalog.models('test').map((model) => model.id)).toEqual(['m1']);
    expect(catalog.providers()).toContain('test');

    upstream = { 'test/m2': { ...modelDef, model: 'm2' } };
    const second = await catalog.refresh({ providerId: 'test' });
    expect(second.changed).toEqual([
      { provider_id: 'test', provider_name: 'test', added: 1, removed: 1 },
    ]);
    await until(() => catalog.models('test').some((model) => model.id === 'm2'));

    offline = true;
    const failed = await catalog.refresh({ providerId: 'test' });
    expect(failed).toEqual({
      changed: [],
      unchanged: [],
      failed: [{ provider: 'test', reason: 'offline' }],
    });
    expect(failures).toHaveLength(1);
    expect(catalog.models('test').map((model) => model.id)).toEqual(['m2']);

    offline = false;
    upstream = { 'test/m3': { ...modelDef, model: 'm3' } };
    let release = (): void => {};
    pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const older = catalog.refresh({ providerId: 'test' });
    upstream = { 'test/m4': { ...modelDef, model: 'm4' } };
    const newer = catalog.refresh({ providerId: 'test' });
    release();
    await Promise.all([older, newer]);
    await until(() => catalog.models('test').map((model) => model.id).join(',') === 'm4');
    pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedRefresh = catalog.refresh({ providerId: 'test' });
    const added = catalog.addModel('test/m5', { ...modelDef, model: 'm5' });
    release();
    await Promise.all([delayedRefresh, added]);
    await until(() => catalog.models('test').length === 2);
    expect(catalog.models('test').map((model) => model.id)).toEqual(['m4', 'm5']);
    expect(changed.length).toBeGreaterThan(0);
    await expect(catalog.refresh({ providerId: 'missing' })).rejects.toMatchObject({
      code: 'provider.not_found',
    });
    await harness.close();
  });
});

describe('providerCatalog config integration', () => {
  it('syncs config sections into the catalog and reacts to config changes', async () => {
    const { harness, config, catalog, file } = await mountWithConfig(
      'default_provider = "ghost"\n\n[providers.ghost]\nbase_url = "https://api.example.com"\ndefault_model = "g1"\n\n[models.g1]\nprovider = "ghost"\nmodel = "g1"\n\n[models.anonymous]\nmodel = "a1"\n',
    );
    await until(() => catalog.providers().includes('ghost'));
    expect(config.get('defaultProvider')).toBe('ghost');
    expect(catalog.providerInfo('ghost')?.baseUrl).toBe('https://api.example.com');
    expect(catalog.models('ghost').map((model) => model.id)).toEqual(['a1', 'g1']);

    await config.set(
      'providers',
      { ghost: { baseUrl: 'https://v2.example.com', defaultModel: 'g1' } },
      'memory',
    );
    await until(() => catalog.providerInfo('ghost')?.baseUrl === 'https://v2.example.com');
    expect(config.inspect('providers')).toEqual({
      value: { ghost: { baseUrl: 'https://v2.example.com', defaultModel: 'g1' } },
      defaultValue: {},
      userValue: { ghost: { baseUrl: 'https://api.example.com', defaultModel: 'g1' } },
      memoryValue: { ghost: { baseUrl: 'https://v2.example.com', defaultModel: 'g1' } },
    });

    await config.replace({ providers: {}, models: {} }, 'memory');
    await until(() => !catalog.providers().includes('ghost'));
    expect(file.saved).toHaveLength(0);
    await harness.close();
  });

  it('writes full refresh records and rebuilds only the target provider model zone', async () => {
    let upstream: CatalogModelRecords = {
      'test/m1': {
        ...modelDef,
        displayName: 'M one',
        supportEfforts: ['low', 'high'],
        defaultEffort: 'low',
        maxOutputSize: 1024,
        protocol: 'anthropic',
        reasoningKey: 'reasoning',
      },
      'test/m2': { ...modelDef, model: 'm2' },
    };
    const { harness, catalog, file } = await mountWithConfig(
      '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nextras = { custom = "canonical" }\noverrides = { display_name = "canonical-override" }\n\n[models."my-fav"]\nprovider = "test"\nmodel = "m1"\ndisplay_name = "mine"\nextras = { custom = "user" }\noverrides = { display_name = "user-override" }\n\n[models."other/solo"]\nprovider = "other"\nmodel = "solo"\n',
      {
        contribute: () => {
          useProvider({ handle: stubHandle('test', failingRequester('boom')), info: { type: 'test-refresh' } });
          useProvider({ handle: stubHandle('test2', failingRequester('boom')), info: { type: 'test-refresh' } });
          useProviderRefresh({
            match: (info) => info.type === 'test-refresh',
            refresh: async ({ providerId }) =>
              providerId === 'test'
                ? upstream
                : {
                    'test2/m1': {
                      ...modelDef,
                      provider: 'test2',
                      maxContextSize: 8192,
                    },
                  },
          });
        },
      },
    );
    const readModels = (): Record<string, Record<string, unknown>> =>
      (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> }).models;
    await catalog.refresh({ providerId: 'test2' });
    const first = await catalog.refresh({ providerId: 'test' });
    expect(first.changed).toEqual([
      { provider_id: 'test', provider_name: 'test', added: 1, removed: 0 },
    ]);
    await until(() => file.saved.length > 0 && readModels()['test2/m1'] !== undefined);
    expect(readModels()['test/m1']).toMatchObject({
      provider: 'test',
      model: 'm1',
      display_name: 'M one',
      support_efforts: ['low', 'high'],
      default_effort: 'low',
      max_output_size: 1024,
      protocol: 'anthropic',
      reasoning_key: 'reasoning',
      extras: { custom: 'canonical' },
      overrides: { display_name: 'canonical-override' },
    });
    expect(readModels()['test2/m1']).toMatchObject({
      provider: 'test2',
      model: 'm1',
      max_context_size: 8192,
    });
    expect(readModels()['other/solo']).toBeDefined();

    upstream = { 'test/m2': { ...modelDef, model: 'm2' } };
    const second = await catalog.refresh({ providerId: 'test' });
    expect(second.changed).toEqual([
      { provider_id: 'test', provider_name: 'test', added: 0, removed: 0 },
    ]);
    await until(() => readModels()['test/m1'] === undefined);
    expect(readModels()['test/m2']).toBeDefined();
    expect(readModels()['test2/m1']).toBeDefined();
    expect(readModels()['other/solo']).toBeDefined();
    expect(readModels()['my-fav']).toMatchObject({
      provider: 'test',
      model: 'm1',
      display_name: 'mine',
      extras: { custom: 'user' },
      overrides: { display_name: 'user-override' },
    });

    const settled = file.saved.length;
    await sleep(20);
    expect(file.saved.length).toBe(settled);
    await harness.close();
  });

  it('prefers user-zone aliases over generated aliases for the same model id', async () => {
    const { harness, catalog } = await mountWithConfig(
      '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\n\n[models."my-fav"]\nprovider = "test"\nmodel = "m1"\ndisplay_name = "mine"\n',
    );
    await until(() => catalog.models('test').length > 0);
    const m1 = catalog.models('test').find((model) => model.id === 'm1');
    expect(m1?.displayName).toBe('mine');
    expect(m1?.extras?.['record']).toMatchObject({
      provider: 'test',
      model: 'm1',
      displayName: 'mine',
    });
    expect(catalog.findByName('m1')).toEqual(['test/m1', 'my-fav']);
    await harness.close();
  });

  it('uses provider init as a fallback and restores models without a providers section', async () => {
    const { harness, config, catalog, models } = await mountWithConfig(
      '[models."solo"]\nprovider_id = "test"\nprovider = "other"\nmodel = "m1"\nname = "wire-m1"\nsupport_efforts = ["low", "high"]\ndefault_effort = "low"\n\n[models."flat"]\nname = "flat"\nbase_url = "https://anon.example.com/v1"\nprotocol = "openai"\nfuture_field = "preserved"\n',
      {
        contribute: () => {
          useProvider({
            handle: stubHandle('test', failingRequester('boom')),
            info: { baseUrl: 'https://contributed.example.com' },
          });
        },
      },
    );
    await until(() => catalog.models('test').some((model) => model.id === 'm1'));
    const solo = catalog.model('test', 'm1');
    expect(solo?.name).toBe('wire-m1');
    expect(solo?.provider).toBe('test');
    expect(catalog.models('other')).toEqual([]);
    expect(catalog.findByName('wire-m1')).toEqual(['solo']);
    expect(catalog.providerInfo('test')?.baseUrl).toBe('https://contributed.example.com');
    expect(catalog.requester('test', 'm1')).toBeDefined();
    expect(models().find((binding) => binding.model.id === 'm1')?.configKey).toBe('solo');
    expect(solo?.thinking).toMatchObject({
      supportEfforts: ['low', 'high'],
      defaultEffort: 'low',
    });

    const flat = catalog.model('anon.example.com', 'flat');
    expect(flat?.name).toBe('flat');
    expect(flat?.extras?.['record']).toMatchObject({ futureField: 'preserved' });
    expect(catalog.requester('anon.example.com', 'flat')).toBeDefined();
    expect(models().find((binding) => binding.model.id === 'flat')?.configKey).toBe('flat');
    expect(config.diagnostics().some((entry) => entry.message.includes("entry 'flat'"))).toBe(false);

    await config.set('providers', { test: { baseUrl: 'https://config.example.com' } }, 'memory');
    await until(() => catalog.providerInfo('test')?.baseUrl === 'https://config.example.com');

    await config.replace({ providers: {} }, 'memory');
    await until(() => catalog.providerInfo('test')?.baseUrl === 'https://contributed.example.com');
    expect(catalog.models('test').map((model) => model.id)).toEqual(['m1']);
    expect(models().find((binding) => binding.model.id === 'm1')?.configKey).toBe('solo');
    await harness.close();
  });

  it('loads a v2-format file with [model_catalog] and a capabilities array, then writes the same format back', async () => {
    const { harness, config, catalog, file } = await mountWithConfig(
      '[model_catalog]\nrefresh_interval_ms = 60000\nrefresh_on_start = false\n\n' +
        '[providers.test]\napi_key_env = "TEST_KEY"\n\n' +
        '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\ncapabilities = [ "image_in", "tool_use" ]\nupgrade = { model = "m2", migration_markdown = "Move", retirement_at = "2027-01-01" }\nfuture_field = "preserved"\n',
    );
    expect(config.get('modelCatalog')).toEqual({ refreshIntervalMs: 60000, refreshOnStart: false });
    await until(() => catalog.models('test').length > 0);
    const m1 = catalog.models('test').find((model) => model.id === 'm1');
    expect(m1?.capability).toEqual({
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      dynamically_loaded_tools: false,
    });
    const loaded = config.get<Record<string, Record<string, unknown>>>('models');
    expect(loaded['test/m1']).toMatchObject({
      futureField: 'preserved',
      upgrade: { model: 'm2', migrationMarkdown: 'Move', retirementAt: '2027-01-01' },
    });
    expect(config.get<Record<string, Record<string, unknown>>>('providers')['test']).toMatchObject({
      apiKeyEnv: 'TEST_KEY',
    });
    await config.replace(
      { models: { 'test/m1': { ...loaded['test/m1'], maxContextSize: 8192 } } },
      'user',
    );
    const text = file.saved.at(-1)!;
    expect(text).toContain('[model_catalog]');
    expect(text).toContain('refresh_interval_ms = 60000');
    const providers = (parseToml(text) as { providers: Record<string, Record<string, unknown>> })
      .providers;
    expect(providers['test']).toMatchObject({ api_key_env: 'TEST_KEY' });
    expect(providers['test']!['apiKeyEnv']).toBeUndefined();
    const models = (parseToml(text) as { models: Record<string, Record<string, unknown>> }).models;
    expect(models['test/m1']).toMatchObject({
      provider: 'test',
      model: 'm1',
      max_context_size: 8192,
      capabilities: ['image_in', 'tool_use'],
      future_field: 'preserved',
      upgrade: { model: 'm2', migration_markdown: 'Move', retirement_at: '2027-01-01' },
    });
    expect(models['test/m1']!['capability']).toBeUndefined();
    expect(models['test/m1']!['maxContextSize']).toBeUndefined();
    await harness.close();
  });

  it('preserves unknown capability entries on disk through the extras channel', async () => {
    const { harness, config, file } = await mountWithConfig(
      '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\ncapabilities = [ "tool_use", "future_cap" ]\n',
    );
    const models = config.get<Record<string, { capability?: Record<string, unknown>; extras?: Record<string, unknown> }>>('models');
    expect(models['test/m1']?.capability?.['tool_use']).toBe(true);
    expect(models['test/m1']?.extras?.['capabilities']).toEqual(['future_cap']);
    await config.replace({ models: { 'test/m1': { ...models['test/m1'], maxContextSize: 100 } } }, 'user');
    const written = (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> }).models;
    expect(written['test/m1']!['capabilities']).toEqual(['tool_use', 'future_cap']);
    expect(written['test/m1']!['max_context_size']).toBe(100);
    expect((written['test/m1']!['extras'] as Record<string, unknown> | undefined)?.['capabilities']).toBeUndefined();
    await harness.close();
  });

  it('warns at load time when a dotted model alias parses as a nested table', async () => {
    const { harness, config } = await mountWithConfig('[models.test.m1]\nprovider = "test"\nmodel = "m1"\n');
    expect(
      config.diagnostics().some(
        (entry) =>
          entry.section === 'models' &&
          entry.message.includes("[models] entry 'test' is missing the 'model' field") &&
          entry.message.includes('[models."test.m1"]'),
      ),
    ).toBe(true);
    await harness.close();
  });
});

describe('kimiModelEnvOverlay', () => {
  const mountWithEnv = async (env: Record<string, string>) => {
    const mounted = await mountWithConfig('', { env });
    return mounted;
  };

  it('applies the KIMI_MODEL_NAME overlay end to end: effective provider/model/defaultModel, a resolvable binding, and no persisted leakage', async () => {
    const { harness, config, catalog, models, file } = await mountWithConfig(
      'default_model = "test/m1"\n\n[providers.test]\ntype = "acme"\napi_key = "sk-static"\n\n[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\n',
      {
        env: { KIMI_MODEL_NAME: 'kimi-for-coding', KIMI_MODEL_API_KEY: 'sk-env' },
        contribute: () => {
          useProviderProtocol({
            type: 'kimi',
            protocols: () => ({ openai: openAIRequester }),
          });
        },
      },
    );
    expect(
      config.get<Record<string, Record<string, unknown>>>('providers')[ENV_MODEL_PROVIDER_KEY],
    ).toEqual({
      type: 'kimi',
      apiKey: 'sk-env',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
    expect(
      config.get<Record<string, Record<string, unknown>>>('models')[ENV_MODEL_ALIAS_KEY],
    ).toEqual({
      provider: ENV_MODEL_PROVIDER_KEY,
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capability: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: false,
      },
    });
    expect(config.get('defaultModel')).toBe(ENV_MODEL_ALIAS_KEY);

    await until(() =>
      models().some(
        (binding) =>
          binding.providerId === ENV_MODEL_PROVIDER_KEY &&
          binding.model.id === 'kimi-for-coding',
      ),
    );
    expect(catalog.isLive(ENV_MODEL_PROVIDER_KEY)).toBe(true);
    expect(catalog.providerInfo(ENV_MODEL_PROVIDER_KEY)?.apiKey).toBe('sk-env');
    expect(catalog.requester(ENV_MODEL_PROVIDER_KEY, 'kimi-for-coding')).toBeDefined();
    expect(matchCatalogBinding(ENV_MODEL_ALIAS_KEY, models())?.model.id).toBe('kimi-for-coding');

    await config.set('defaultModel', config.get('defaultModel'), 'user');
    expect(file.saved).toHaveLength(0);
    await config.set('providers', { acme2: { type: 'acme', apiKey: 'sk-2' } }, 'user');
    let written = file.saved.at(-1)!;
    expect(written).toContain('[providers.acme2]');
    expect(written).not.toContain(ENV_MODEL_PROVIDER_KEY);
    expect(written).not.toContain('sk-env');
    await config.replace(
      {
        models: {
          ...config.get<Record<string, Record<string, unknown>>>('models'),
          'test/m2': { provider: 'test', model: 'm2' },
        },
      },
      'user',
    );
    written = file.saved.at(-1)!;
    expect(written).toContain('[models."test/m2"]');
    expect(written).toContain('[models."test/m1"]');
    expect(written).not.toContain(ENV_MODEL_ALIAS_KEY);
    expect(written).not.toContain(ENV_MODEL_PROVIDER_KEY);
    expect(written).toContain('default_model = "test/m1"');
    expect(config.get('defaultModel')).toBe(ENV_MODEL_ALIAS_KEY);
    await harness.close();
  });

  it('populates model_overrides from the KIMI_MODEL_* knobs without a model name and never persists it', async () => {
    const { harness, config, file } = await mountWithConfig('', {
      env: {
        KIMI_MODEL_TEMPERATURE: '0.7',
        KIMI_MODEL_TOP_P: '0.95',
        KIMI_MODEL_THINKING_KEEP: 'all',
        KIMI_MODEL_MAX_COMPLETION_TOKENS: '4096',
        KIMI_MODEL_MAX_TOKENS: '2048',
      },
    });
    expect(config.get('modelOverrides')).toEqual({
      temperature: 0.7,
      topP: 0.95,
      thinkingKeep: 'all',
      maxCompletionTokens: 4096,
    });
    expect(config.get('defaultModel')).toBeUndefined();
    await config.replace(
      { modelOverrides: config.get('modelOverrides'), defaultModel: 'test/m1' },
      'user',
    );
    const written = file.saved.at(-1)!;
    expect(written).toContain('default_model = "test/m1"');
    expect(written).not.toContain('model_overrides');
    await harness.close();

    const legacy = await mountWithEnv({ KIMI_MODEL_MAX_TOKENS: '2048' });
    expect(legacy.config.get('modelOverrides')).toEqual({ maxCompletionTokens: 2048 });
    await legacy.harness.close();
  });

  it('maps extended model metadata, resolves the env provider endpoint chain, and reports invalid env values as diagnostics', async () => {
    const extended = await mountWithEnv({
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_MAX_CONTEXT_SIZE: '1000000',
      KIMI_MODEL_MAX_OUTPUT_SIZE: '8192',
      KIMI_MODEL_CAPABILITIES: 'Image_In, thinking , tool_use',
      KIMI_MODEL_DISPLAY_NAME: 'Custom Model',
      KIMI_MODEL_REASONING_KEY: 'reasoning',
      KIMI_MODEL_ADAPTIVE_THINKING: 'true',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: 'https://proxy.example.com/v1',
      KIMI_MODEL_TEMPERATURE: '0.3',
    });
    const extendedConfig = extended.config;
    expect(extendedConfig.get('modelOverrides')).toEqual({ temperature: 0.3 });
    expect(
      extendedConfig.get<Record<string, Record<string, unknown>>>('models')[ENV_MODEL_ALIAS_KEY],
    ).toEqual({
      provider: ENV_MODEL_PROVIDER_KEY,
      model: 'env-model',
      maxContextSize: 1000000,
      maxOutputSize: 8192,
      capability: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
      },
      displayName: 'Custom Model',
      reasoningKey: 'reasoning',
      adaptiveThinking: true,
    });
    expect(
      extendedConfig.get<Record<string, Record<string, unknown>>>('providers')[
        ENV_MODEL_PROVIDER_KEY
      ],
    ).toEqual({ type: 'openai', baseUrl: 'https://proxy.example.com/v1' });
    await extended.harness.close();

    const openai = await mountWithEnv({
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
    });
    expect(
      openai.config.get<Record<string, Record<string, unknown>>>('providers')[
        ENV_MODEL_PROVIDER_KEY
      ],
    ).toEqual({ type: 'openai' });
    await openai.harness.close();

    const invalid = await mountWithEnv({
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_TEMPERATURE: 'hot',
    });
    const invalidConfig = invalid.config;
    expect(invalidConfig.get('defaultModel')).toBeUndefined();
    expect(
      invalidConfig.diagnostics().some(
        (entry) =>
          entry.message.includes('Ignoring config environment overlay') &&
          entry.message.includes('KIMI_MODEL_TEMPERATURE must be a number'),
      ),
    ).toBe(true);
    await invalid.harness.close();
  });
});

describe('provider-catalog materialization', () => {
  it('materializes a config-declared provider, refreshes models under the provider id, and unbinds on removal', async () => {
    const seen: { url: string; authorization?: string }[] = [];
    let upstream: readonly string[] = ['m1', 'm2'];
    let malformed = false;
    let invalidItem = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: typeof input === 'string' ? input : input.url,
        authorization: (init?.headers as Record<string, string> | undefined)?.['authorization'],
      });
      const data = invalidItem ? [null] : upstream.map((id) => ({ id }));
      return new Response(JSON.stringify(malformed ? {} : { data }), { status: 200 });
    });
    try {
      const { harness, config, catalog, file } = await mountWithConfig(
        '[providers.acme]\ntype = "acme"\nbase_url = "https://acme.example.com"\nmodel_source = "discover"\napi_key = "sk-resolved"\n',
        {
          contribute: () => {
            useProviderProtocol({
              type: 'acme',
              protocols: () => ({ openai: openAIRequester }),
            });
            useProviderProtocol({
              type: 'anthropic',
              protocols: () => ({ anthropic: anthropicRequester }),
            });
          },
        },
      );
      await catalog.refresh({ providerId: 'acme' });
      await until(() => seen.length > 0);
      expect(seen[0]).toEqual({
        url: 'https://acme.example.com/models',
        authorization: 'Bearer sk-resolved',
      });
      await until(() => catalog.models('acme').length === 2);
      expect(catalog.models('acme').map((model) => model.id)).toEqual(['m1', 'm2']);
      expect(catalog.requester('acme', 'm1')).toBeDefined();
      const readModels = (): Record<string, Record<string, unknown>> =>
        (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> })
          .models;
      await until(() => file.saved.length > 0 && readModels()['acme/m2'] !== undefined);
      expect(readModels()['acme/m1']).toMatchObject({ provider: 'acme', model: 'm1' });
      expect(readModels()['acme/m2']).toMatchObject({ provider: 'acme', model: 'm2' });
      expect(readModels()['acme/m1']!['api_key']).toBeUndefined();

      await config.set(
        'models',
        {
          ...config.get<Record<string, CatalogModelConfig>>('models'),
          'acme/override': { provider: 'acme', model: 'override', protocol: 'anthropic' },
        },
        'user',
      );
      await until(() => catalog.requester('acme', 'override') !== undefined);

      upstream = ['m2'];
      await catalog.refresh({ providerId: 'acme' });
      await until(() => readModels()['acme/m1'] === undefined);
      expect(readModels()['acme/m2']).toBeDefined();

      malformed = true;
      expect((await catalog.refresh({ providerId: 'acme' })).failed).toHaveLength(1);
      await sleep(20);
      expect(catalog.models('acme').map((model) => model.id)).toEqual(['m2']);

      malformed = false;
      invalidItem = true;
      expect((await catalog.refresh({ providerId: 'acme' })).failed).toHaveLength(1);
      await sleep(20);
      expect(catalog.models('acme').map((model) => model.id)).toEqual(['m2']);

      invalidItem = false;
      upstream = [];
      expect(await catalog.refresh({ providerId: 'acme' })).toEqual({
        changed: [],
        unchanged: ['acme'],
        failed: [],
      });
      expect(catalog.models('acme').map((model) => model.id)).toEqual(['m2']);
      expect(catalog.providers()).toContain('acme');

      upstream = ['m2'];
      await catalog.refresh({ providerId: 'acme' });
      await until(() => catalog.models('acme').length === 1);
      await config.replace(
        {
          providers: {
            acme: { type: 'acme', modelSource: 'discover' },
          },
        },
        'memory',
      );
      await until(() => catalog.providerInfo('acme')?.baseUrl === undefined);
      expect(await catalog.refresh({ providerId: 'acme' })).toEqual({
        changed: [],
        unchanged: ['acme'],
        failed: [],
      });
      await sleep(20);
      expect(catalog.models('acme').map((model) => model.id)).toEqual(['m2']);

      await config.replace({ providers: {}, models: {} }, 'memory');
      await until(() => !catalog.providers().includes('acme'));
      expect(catalog.isLive('acme')).toBe(false);
      const settled = file.saved.length;
      await sleep(20);
      expect(file.saved.length).toBe(settled);
      await harness.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fetch models for static providers and materializes oauth-backed providers', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { harness, catalog } = await mountWithConfig(
        '[providers.acme]\ntype = "acme"\nbase_url = "https://acme.example.com"\napi_key = "sk-x"\n\n[providers.managed]\ntype = "acme"\nmodel_source = "oauth-catalog"\nbase_url = "https://managed.example.com"\n\n[providers.legacy]\ntype = "acme"\nbase_url = "https://legacy.example.com"\n\n[providers.legacy.oauth]\nstorage = "file"\nkey = "oauth/legacy"\n\n[providers.ghost]\ntype = "nope"\nbase_url = "https://ghost.example.com"\n\n' +
          '[providers.openai]\ntype = "openai"\n\n[providers.responses]\ntype = "openai_responses"\n\n[providers.anthropic]\ntype = "anthropic"\n\n[providers.google]\ntype = "google-genai"\n\n[providers.vertex]\ntype = "vertexai"\n',
        {
          contribute: () => {
            useProviderProtocol({
              type: 'acme',
              protocols: () => ({ openai: openAIRequester }),
            });
          },
        },
      );
      await sleep(20);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(catalog.isLive('acme')).toBe(true);
      expect(catalog.isLive('managed')).toBe(true);
      expect(catalog.isLive('legacy')).toBe(true);
      expect(catalog.isLive('ghost')).toBe(false);
      expect(catalog.isLive('openai')).toBe(true);
      expect(catalog.isLive('responses')).toBe(true);
      expect(catalog.isLive('anthropic')).toBe(true);
      expect(catalog.isLive('google')).toBe(true);
      expect(catalog.isLive('vertex')).toBe(true);
      await harness.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('provider-catalog credential resolvers', () => {
  it('resolves model and provider credentials with v2 precedence, conflicts, and live env reads', async () => {
    const sentinel: LlmCredentialProvider = { resolve: () => ({ apiKey: 'sk-sentinel' }) };
    const env: Record<string, string> = { ACME_KEY: 'sk-env' };
    const { harness, config, catalog, capture } = await mountWithConfig(undefined, {
      env,
      contribute: () => {
        useCredentialResolver({
          resolve: (info) =>
            info.type === 'sentinel' || info.oauth?.key === 'oauth/sentinel' ? sentinel : undefined,
        });
      },
    });
    const resolvers = capture.credentials?.value ?? [];
    expect(await resolveCredentialProvider({ apiKey: 'sk-inline' }, resolvers)?.resolve()).toEqual({
      apiKey: 'sk-inline',
    });
    expect(resolveCredentialProvider({ type: 'sentinel', apiKey: 'sk-x' }, resolvers)).toBe(
      sentinel,
    );
    expect(resolveCredentialProvider({}, resolvers)).toBeUndefined();

    const oauth = { storage: 'file' as const, key: 'oauth/sentinel' };
    await config.replace(
      {
        providers: {
          live: {
            type: 'openai',
            apiKeyEnv: 'ACME_KEY',
            baseUrl: 'https://provider.example.com',
            customHeaders: { shared: 'provider', provider: 'yes' },
            env: { OPENAI_API_KEY: 'sk-direct', OPENAI_BASE_URL: 'https://env.example.com' },
          },
          direct: {
            type: 'openai',
            env: { OPENAI_API_KEY: 'sk-direct', OPENAI_BASE_URL: 'https://env.example.com' },
          },
          inlineDirect: {
            type: 'openai',
            apiKey: 'sk-inline-provider',
            env: { OPENAI_API_KEY: 'sk-direct' },
          },
          oauthOnly: { type: 'openai', oauth },
          conflicted: { type: 'openai', apiKey: 'sk-provider', apiKeyEnv: 'ACME_KEY', oauth },
          envOauth: { type: 'openai', env: { OPENAI_API_KEY: 'sk-direct' }, oauth },
          envDeclaredOauth: { type: 'openai', apiKeyEnv: 'ACME_KEY', oauth },
          inlineOauth: { type: 'openai', apiKey: 'sk-provider', oauth },
        },
        models: {
          'live/m': {
            provider: 'live',
            model: 'm',
            baseUrl: 'https://model.example.com',
            defaultHeaders: { shared: 'model', model: 'yes' },
          },
          'direct/m': { provider: 'direct', model: 'm' },
          'inlineDirect/m': { provider: 'inlineDirect', model: 'm' },
          'oauthOnly/m': { provider: 'oauthOnly', model: 'm' },
          'conflicted/model-inline': {
            provider: 'conflicted',
            model: 'model-inline',
            apiKey: 'sk-model',
          },
          'conflicted/model-oauth': { provider: 'conflicted', model: 'model-oauth', oauth },
          'conflicted/model-conflict': {
            provider: 'conflicted',
            model: 'model-conflict',
            apiKey: 'sk-model',
            oauth,
          },
          'conflicted/provider-fallback': { provider: 'conflicted', model: 'provider-fallback' },
          'envOauth/m': { provider: 'envOauth', model: 'm' },
          'envDeclaredOauth/m': { provider: 'envDeclaredOauth', model: 'm' },
          'inlineOauth/m': { provider: 'inlineOauth', model: 'm' },
        },
      },
      'memory',
    );
    await until(() => catalog.models('conflicted').length === 4);
    expect(catalog.models('conflicted').map((model) => model.id)).toEqual([
      'model-conflict',
      'model-inline',
      'model-oauth',
      'provider-fallback',
    ]);

    const request = (providerId: string, modelId: string): LlmRequest => {
      const requester = catalog.requester(providerId, modelId);
      if (requester === undefined) throw new Error(`missing requester for ${providerId}/${modelId}`);
      return requester.request({ content: { messages: [] } });
    };
    const apiKey = async (providerId: string, modelId: string): Promise<string | undefined> =>
      (await request(providerId, modelId).endpoint?.credentials?.resolve())?.apiKey;

    expect(request('live', 'm').endpoint).toMatchObject({
      baseUrl: 'https://model.example.com',
      headers: { shared: 'model', provider: 'yes', model: 'yes' },
    });
    await expect(apiKey('live', 'm')).resolves.toBe('sk-env');
    env.ACME_KEY = 'sk-next';
    await expect(apiKey('live', 'm')).resolves.toBe('sk-next');
    expect(request('direct', 'm').endpoint?.baseUrl).toBe('https://env.example.com');
    await expect(apiKey('direct', 'm')).resolves.toBe('sk-direct');
    await expect(apiKey('inlineDirect', 'm')).resolves.toBe('sk-inline-provider');
    await expect(apiKey('oauthOnly', 'm')).resolves.toBe('sk-sentinel');
    await expect(apiKey('conflicted', 'model-inline')).resolves.toBe('sk-model');
    await expect(apiKey('conflicted', 'model-oauth')).resolves.toBe('sk-sentinel');

    expect(() => catalog.requester('conflicted', 'model-conflict')).toThrow(
      'Model "conflicted/model-conflict" has both apiKey and oauth',
    );
    expect(() => catalog.requester('conflicted', 'provider-fallback')).toThrow(
      'Provider "conflicted" has both apiKey and apiKeyEnv',
    );
    expect(() => catalog.requester('envOauth', 'm')).toThrow(
      'Provider "envOauth" has both apiKey and oauth',
    );
    expect(() => catalog.requester('envDeclaredOauth', 'm')).toThrow(
      'Provider "envDeclaredOauth" has both apiKeyEnv and oauth',
    );
    expect(() => catalog.requester('inlineOauth', 'm')).toThrow(
      'Provider "inlineOauth" has both apiKey and oauth',
    );
    await harness.close();
  });
});

describe('provider-catalog default model restore', () => {
  it('restores the model binding on agent mount from defaultModel and keeps explicit overrides', async () => {
    const { harness, config, file } = await mountWithConfig(
      'default_model = "test/m1"\n\n[providers.test]\ntype = "acme"\napi_key = "sk-static"\n\n[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\n',
      {
        contribute: () => {
          useProviderProtocol({
            type: 'acme',
            protocols: () => ({ openai: openAIRequester }),
          });
        },
      },
    );
    const session = await harness.open('sess');
    await session.ensureAgent('main');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    expect(boundModel(harness, 'sess', 'main').spec?.provider).toBe('test');
    expect(boundModel(harness, 'sess', 'main').spec?.maxContextSize).toBe(4096);

    runtimeOf(harness, 'sess', 'main').requester = fakeRequester(() => textOutcome('ok')).with({
      model: { spec: { provider: 'test', name: 'other', capability: modelDef.capability } },
    });
    await sleep(20);
    expect(boundModel(harness, 'sess', 'main').spec?.name).toBe('other');

    await config.set('defaultModel', 'test/m2', 'user');
    expect(file.saved.at(-1)).toContain('default_model = "test/m2"');
    await harness.close();
  });

  it('skips the restore silently when defaultModel has no binding', async () => {
    const { harness } = await mountWithConfig(
      'default_model = "ghost/nope"\n\n[providers.test]\ntype = "acme"\napi_key = "sk-static"\n',
      {
        contribute: () => {
          useProviderProtocol({
            type: 'acme',
            protocols: () => ({ openai: openAIRequester }),
          });
        },
      },
    );
    const session = await harness.open('sess');
    await session.ensureAgent('main');
    await sleep(20);
    expect(boundModel(harness, 'sess', 'main').spec).toBeUndefined();
    await harness.close();
  });
});

const m1Def: CatalogModelConfig = {
  provider: 'test',
  model: 'm1',
  capability: testCapability(true),
  maxContextSize: 4096,
  supportEfforts: ['low', 'high'],
  defaultEffort: 'low',
  offEffort: 'none',
};

const m2Def: CatalogModelConfig = {
  provider: 'other',
  model: 'm2',
  capability: testCapability(false),
  maxContextSize: 8192,
};

interface SeenCall {
  readonly spec?: LlmModelSpec;
  readonly thinking?: ThinkingRequestOptions;
  readonly credentials?: LlmCredentialProvider;
}

function textRequester(seen: SeenCall[]): LoopLlmRequester {
  return fakeRequester((rest) => {
    seen.push({
      spec: (rest['model'] as LlmRequestModel | undefined)?.spec,
      thinking: (rest['model'] as LlmRequestModel | undefined)?.thinking,
      credentials: (rest['endpoint'] as LlmEndpoint | undefined)?.credentials,
    });
    return textOutcome('ok');
  });
}

async function resolveApiKey(call: SeenCall | undefined): Promise<string | undefined> {
  return (await call?.credentials?.resolve())?.apiKey;
}

interface ModelFixture {
  readonly harness: App;
  readonly session: Awaited<ReturnType<App['app']['create']>>;
  readonly main: EnsuredAgent;
  readonly file: { saved: string[]; persist: ConfigPersist };
  readonly config: ConfigStore;
  readonly capture: ProbeCapture;
  readonly seen: { m1: SeenCall[]; m2: SeenCall[] };
}

async function mountFixture(initial?: string): Promise<ModelFixture> {
  const file = fakePersist(initial);
  const seen = { m1: [] as SeenCall[], m2: [] as SeenCall[] };
  const capture: ProbeCapture = {};
  const harness = createApp({ space: memorySessionSpace() });
  harness.features.add(providerCatalog);
  harness.features.add(createConfig({ persist: file.persist }));
  harness.features.add(
    catalogProbe(capture, () => {
      useProvider({
        handle: stubHandle('test', textRequester(seen.m1)),
        info: { apiKey: 'sk-test' },
      });
      useProvider({
        handle: stubHandle('other', textRequester(seen.m2)),
        info: { apiKey: 'sk-other' },
      });
    }),
  );
  await tick();
  const config = capture.config?.value;
  const catalog = capture.catalog?.value;
  if (config === undefined || catalog === undefined) {
    throw new Error('config store or provider catalog was not exposed');
  }
  await config.reload();
  await catalog.addModel('test/m1', m1Def);
  await catalog.addModel('other/m2', m2Def);
  const session = await harness.open('sess');
  const { agent: main } = await session.ensureAgent('main');
  return { harness, session, main, file, config, capture, seen };
}

describe('provider-catalog app model defaults', () => {
  it('persists the default model to the user config target as a snake_case scalar', async () => {
    const { harness, file, config, capture } = await mountFixture();
    await until(() => (capture.models?.value.length ?? 0) === 2);
    const defaults = capture.defaults?.value;
    if (defaults === undefined) throw new Error('model defaults face was not exposed');
    await defaults.setDefaultModel('other/m2');
    expect(file.saved.at(-1)).toContain('default_model = "other/m2"');
    await config.set('defaultProvider', 'other', 'user');
    expect(file.saved.at(-1)).toContain('default_provider = "other"');
    await harness.close();
  });

  it('edits an existing default_model scalar in place and keeps its trailing comment', async () => {
    const { harness, file, capture } = await mountFixture('default_model = "test/m1"   # current pick\n');
    await until(() => (capture.models?.value.length ?? 0) === 2);
    const defaults = capture.defaults?.value;
    if (defaults === undefined) throw new Error('model defaults face was not exposed');
    await defaults.setDefaultModel('other/m2');
    expect(file.saved.at(-1)).toContain('default_model = "other/m2"   # current pick\n');
    await harness.close();
  });

  it('rejects an unknown alias with a coded error', async () => {
    const { harness, capture } = await mountFixture();
    await until(() => (capture.models?.value.length ?? 0) === 2);
    const defaults = capture.defaults?.value;
    if (defaults === undefined) throw new Error('model defaults face was not exposed');
    await expect(defaults.setDefaultModel('ghost/nope')).rejects.toMatchObject({
      code: 'model.unknown_alias',
    });
    await harness.close();
  });

  it('rejects when the config feature is not mounted', async () => {
    const capture: ProbeCapture = {};
    const harness = createApp({ space: memorySessionSpace() });
    harness.features.add(providerCatalog);
    harness.features.add(
      catalogProbe(capture, () => {
        useProvider({ handle: stubHandle('test', textRequester([])) });
      }),
    );
    await tick();
    const catalog = capture.catalog?.value;
    if (catalog === undefined) throw new Error('provider catalog face was not exposed');
    await expect(catalog.addModel('test/m1', m1Def)).rejects.toMatchObject({
      code: 'config.unavailable',
    });
    await harness.close();
  });

  it('merges the default thinking effort without persisting the env-forced effort', async () => {
    const { harness, config, file, capture } = await mountWithConfig(undefined, {
      env: { KIMI_MODEL_THINKING_EFFORT: 'low' },
    });
    expect(config.get<{ forcedEffort?: string }>('thinking').forcedEffort).toBe('low');
    const defaults = capture.defaults?.value;
    if (defaults === undefined) throw new Error('model defaults face was not exposed');
    await defaults.setDefaultThinking('high');
    const text = file.saved.at(-1)!;
    expect(text).toContain('effort = "high"');
    expect(text).not.toContain('forcedEffort');
    expect(text).not.toContain('forced_effort');
    await harness.close();
  });
});

describe('provider-catalog agent model binding', () => {
  it('binds config, requester and credential atomically and records the binding', async () => {
    const { harness, main, seen, capture } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    const face = capture.agentFace;
    if (face === undefined) throw new Error('agent model face was not captured');
    await face.setModel('other/m2');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm2');
    expect(face.current.value).toEqual({ alias: 'other/m2', thinking: null });
    const outcome = await main.loop.runTurn(user('hi'));
    expect(outcome.type).toBe('done');
    expect(seen.m1).toHaveLength(0);
    expect(seen.m2.at(-1)?.spec?.name).toBe('m2');
    await expect(resolveApiKey(seen.m2.at(-1))).resolves.toBe('sk-other');
    await harness.close();
  });

  it('restores the durable binding on remount ahead of app defaults', async () => {
    const { harness, session, capture } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    const face = capture.agentFace;
    if (face === undefined) throw new Error('agent model face was not captured');
    await face.setModel('other/m2');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm2');
    await session.closeAgent('main');
    await session.ensureAgent('main');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm2');
    expect(capture.agentFace?.current.value).toEqual({ alias: 'other/m2', thinking: null });
    await harness.close();
  });

  it('binds the app-level default model when no session or agent default exists', async () => {
    const { harness } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    expect(boundModel(harness, 'sess', 'main').spec?.maxContextSize).toBe(4096);
    await harness.close();
  });

  it('resolves the default model written as a custom models-section alias key or record alias', async () => {
    const { harness, capture } = await mountFixture(
      'default_model = "my-alias"\n\n' +
        '[models."my-alias"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 2048\naliases = ["nick"]\n',
    );
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    expect(boundModel(harness, 'sess', 'main').spec?.maxContextSize).toBe(2048);
    const bindings = capture.models?.value ?? [];
    expect(matchCatalogBinding('my-alias', bindings)?.model.id).toBe('m1');
    expect(matchCatalogBinding('nick', bindings)?.model.id).toBe('m1');
    await harness.close();
  });

  it('prefers session defaults over the app default', async () => {
    const { harness, config } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    await writeSessionDefaults(harness, 'sess', { defaultModel: 'other/m2' });
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm2');
    await config.set('defaultModel', 'test/m1', 'user');
    await sleep(20);
    expect(boundModel(harness, 'sess', 'main').spec?.name).toBe('m2');
    await harness.close();
  });

  it('prefers the agent binding over session defaults', async () => {
    const { harness, capture } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    const face = capture.agentFace;
    if (face === undefined) throw new Error('agent model face was not captured');
    await face.setModel('other/m2');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm2');
    await writeSessionDefaults(harness, 'sess', { defaultModel: 'test/m1' });
    await sleep(20);
    expect(boundModel(harness, 'sess', 'main').spec?.name).toBe('m2');
    await harness.close();
  });

  it('rebinds a live agent when the session default changes', async () => {
    const { harness, main, seen } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    await writeSessionDefaults(harness, 'sess', { defaultModel: 'other/m2' });
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm2');
    const outcome = await main.loop.runTurn(user('hi'));
    expect(outcome.type).toBe('done');
    expect(seen.m1).toHaveLength(0);
    await expect(resolveApiKey(seen.m2.at(-1))).resolves.toBe('sk-other');
    await harness.close();
  });

  it('keeps the current binding silently when the effective alias cannot be resolved', async () => {
    const { harness } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    await writeSessionDefaults(harness, 'sess', { defaultModel: 'ghost/nope' });
    await sleep(20);
    expect(boundModel(harness, 'sess', 'main').spec?.name).toBe('m1');
    await harness.close();
  });

  it('stops managing an agent after an external requester override', async () => {
    const { harness, config } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    runtimeOf(harness, 'sess', 'main').requester = fakeRequester(() => textOutcome('ok')).with({
      model: { spec: { provider: 'test', name: 'custom', capability: testCapability(true) } },
    });
    await writeSessionDefaults(harness, 'sess', { defaultModel: 'other/m2' });
    await sleep(20);
    expect(boundModel(harness, 'sess', 'main').spec?.name).toBe('custom');
    await config.set('defaultModel', 'other/m2', 'user');
    await sleep(20);
    expect(boundModel(harness, 'sess', 'main').spec?.name).toBe('custom');
    await harness.close();
  });
});

describe('provider-catalog agent thinking effort', () => {
  it('rejects an unsupported effort and applies a valid one durably', async () => {
    const { harness, session, config, capture } = await mountFixture(
      'default_model = "test/m1"\n\n[thinking]\nkeep = "config-keep"\n\n[model_overrides]\ntemperature = 0.25\ntop_p = 0.75\nthinking_keep = "override-keep"\nmax_completion_tokens = 123\n',
    );
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    const face = capture.agentFace;
    if (face === undefined) throw new Error('agent model face was not captured');
    await expect(face.setThinking('turbo')).rejects.toMatchObject({
      code: 'model.invalid_thinking',
    });
    await face.setThinking('high');
    await until(() => boundModel(harness, 'sess', 'main').thinking?.effort === 'high');
    expect(boundModel(harness, 'sess', 'main')).toMatchObject({
      thinking: { effort: 'high', keep: 'override-keep' },
      sampling: { temperature: 0.25, topP: 0.75 },
      maxOutputTokens: 123,
    });
    expect(face.current.value).toEqual({ alias: null, thinking: 'high' });
    await session.closeAgent('main');
    await session.ensureAgent('main');
    await until(() => boundModel(harness, 'sess', 'main').thinking?.effort === 'high');
    expect(boundModel(harness, 'sess', 'main').spec?.name).toBe('m1');
    expect(boundModel(harness, 'sess', 'main').thinking?.keep).toBe('override-keep');

    await config.replace(
      {
        modelOverrides: {
          temperature: 0.25,
          topP: 0.75,
          thinkingKeep: 'off',
          maxCompletionTokens: 0,
        },
      },
      'memory',
    );
    await until(() => boundModel(harness, 'sess', 'main').thinking?.keep === undefined);
    expect(boundModel(harness, 'sess', 'main').thinking?.effort).toBe('high');
    expect(boundModel(harness, 'sess', 'main').maxOutputTokens).toBe('none');

    await config.replace(
      {
        modelOverrides: { temperature: 0.25, topP: 0.75, maxCompletionTokens: 123 },
      },
      'memory',
    );
    await until(() => boundModel(harness, 'sess', 'main').thinking?.keep === 'config-keep');
    await config.replace({ thinking: {} }, 'memory');
    await until(() => boundModel(harness, 'sess', 'main').thinking?.keep === 'all');
    const reopenedFace = capture.agentFace;
    if (reopenedFace === undefined) throw new Error('reopened agent model face was not captured');
    await reopenedFace.setThinking('off');
    await until(() => boundModel(harness, 'sess', 'main').thinking?.effort === 'off');
    expect(boundModel(harness, 'sess', 'main').thinking?.keep).toBeUndefined();
    expect(boundModel(harness, 'sess', 'main').maxOutputTokens).toBe(123);
    await harness.close();
  });

  it('rejects thinking efforts for a model without thinking support', async () => {
    const { harness, capture } = await mountFixture('default_model = "other/m2"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm2');
    const face = capture.agentFace;
    if (face === undefined) throw new Error('agent model face was not captured');
    await expect(face.setThinking('high')).rejects.toMatchObject({
      code: 'model.invalid_thinking',
    });
    await harness.close();
  });
});

describe('provider-catalog session model defaults', () => {
  it('writes session defaults and binds the live main agent', async () => {
    const { harness, capture } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    const face = capture.sessionFace;
    if (face === undefined) throw new Error('session model face was not captured');
    await face.setThinking('high');
    expect((await sessionDefaultsState(harness, 'sess')).defaultThinking).toBe('high');
    await until(() => boundModel(harness, 'sess', 'main').thinking?.effort === 'high');
    await face.setModel('other/m2');
    expect((await sessionDefaultsState(harness, 'sess')).defaultModel).toBe('other/m2');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm2');
    await expect(face.setThinking('low')).rejects.toMatchObject({
      code: 'model.invalid_thinking',
    });
    expect((await sessionDefaultsState(harness, 'sess')).defaultThinking).toBe('high');
    await expect(face.setModel('ghost/nope')).rejects.toMatchObject({
      code: 'model.unknown_alias',
    });
    await harness.close();
  });

  it('restores session defaults for a reopened session', async () => {
    const space = memorySessionSpace();
    const file = fakePersist('default_model = "test/m1"\n');
    const seen = { m1: [] as SeenCall[], m2: [] as SeenCall[] };
    const mount = async (): Promise<{ harness: App; capture: ProbeCapture }> => {
      const capture: ProbeCapture = {};
      const harness = createApp({ space });
      harness.features.add(providerCatalog);
      harness.features.add(createConfig({ persist: file.persist }));
      harness.features.add(
        catalogProbe(capture, () => {
          useProvider({
            handle: stubHandle('test', textRequester(seen.m1)),
            info: { apiKey: 'sk-test' },
          });
          useProvider({
            handle: stubHandle('other', textRequester(seen.m2)),
            info: { apiKey: 'sk-other' },
          });
        }),
      );
      await tick();
      const config = capture.config?.value;
      const catalog = capture.catalog?.value;
      if (config === undefined || catalog === undefined) {
        throw new Error('config store or provider catalog was not exposed');
      }
      await config.reload();
      await catalog.addModel('test/m1', m1Def);
      await catalog.addModel('other/m2', m2Def);
      return { harness, capture };
    };
    const first = await mount();
    const session = await first.harness.open('sess');
    await session.ensureAgent('main');
    await until(() => boundModel(first.harness, 'sess', 'main').spec?.name === 'm1');
    const face = first.capture.sessionFace;
    if (face === undefined) throw new Error('session model face was not captured');
    await face.setModel('other/m2');
    await until(() => boundModel(first.harness, 'sess', 'main').spec?.name === 'm2');
    await first.harness.close();

    const second = await mount();
    const resumed = await second.harness.open('sess');
    await resumed.ensureAgent('main');
    await until(() => boundModel(second.harness, 'sess', 'main').spec?.name === 'm2');
    expect(boundModel(second.harness, 'sess', 'main').spec?.name).toBe('m2');
    await second.harness.close();
  });
});
