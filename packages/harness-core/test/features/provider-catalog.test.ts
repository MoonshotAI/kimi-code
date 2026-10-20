import { parse as parseToml } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useCollection, useInject, watch, type ComputedRef, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { openAIRequester } from '@moonshot-ai/agent-core/llm/builtin/provider/index';
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

import {
  ENV_MODEL_PROVIDER_KEY,
  createConfig,
  useConfig,
  type ConfigPersist,
  type ConfigStore,
} from '#/features/config/index';
import {
  AgentModelRef,
  CatalogModels,
  CredentialResolvers,
  ENV_MODEL_ALIAS_KEY,
  ModelDefaultsRef,
  SESSION_MODEL_DEFAULTS,
  SessionModelRef,
  catalogModelDefinitionOf,
  matchCatalogBinding,
  providerCatalog,
  resolveCredentialProvider,
  sessionModelDefaultsProjection,
  useCredentialResolver,
  useProvider,
  useProviderCatalog,
  useProviderProtocol,
  type AgentModelFace,
  type CatalogModelBinding,
  type CatalogModelConfig,
  type CatalogProviderHandle,
  type ModelDefaultsFace,
  type ProviderCatalogFace,
  type SessionModelDefaults,
  type SessionModelFace,
} from '#/features/provider-catalog/index';
import {
  createHarness,
  featureWriterOf,
  harnessInternals,
  memoryHarnessSpace,
  type AgentRuntime,
  type Harness,
} from '#/runtime/index';

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
  listModels?: () => Promise<readonly CatalogModelConfig[]>,
): CatalogProviderHandle {
  return {
    id,
    requester,
    listModels:
      listModels === undefined
        ? undefined
        : async () => (await listModels()).map(catalogModelDefinitionOf),
  };
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
  harness: Harness;
  catalog: ProviderCatalogFace;
  models: () => readonly CatalogModelBinding[];
}> {
  const capture: ProbeCapture = {};
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(providerCatalog);
  harness.app.features.add(catalogProbe(capture, contribute));
  await tick();
  const catalog = capture.catalog?.value;
  if (catalog === undefined) throw new Error('provider catalog face was not exposed');
  return { harness, catalog, models: () => capture.models?.value ?? [] };
}

async function mountWithConfig(
  initial: string | undefined,
  options: { env?: Record<string, string>; contribute?: () => void } = {},
): Promise<{
  harness: Harness;
  file: { saved: string[]; persist: ConfigPersist };
  config: ConfigStore;
  catalog: ProviderCatalogFace;
  capture: ProbeCapture;
  models: () => readonly CatalogModelBinding[];
}> {
  const file = fakePersist(initial);
  const capture: ProbeCapture = {};
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(providerCatalog);
  harness.app.features.add(createConfig({ persist: file.persist, env: options.env }));
  harness.app.features.add(catalogProbe(capture, options.contribute));
  await tick();
  const config = capture.config?.value;
  const catalog = capture.catalog?.value;
  if (config === undefined || catalog === undefined) {
    throw new Error('config or catalog face was not exposed');
  }
  await config.reload();
  return { harness, file, config, catalog, capture, models: () => capture.models?.value ?? [] };
}

function runtimeOf(harness: Harness, sessionId: string, agentId: string): AgentRuntime {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined
      ? harnessInternals(harness.app).agents.get(session)?.get(agentId)
      : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  return runtime;
}

function boundModel(
  harness: Harness,
  sessionId: string,
  agentId: string,
): { spec?: LlmModelSpec; thinking?: ThinkingRequestOptions } {
  const request = runtimeOf(harness, sessionId, agentId).requester?.request({
    content: { messages: [] },
  });
  const model = request?.model as LlmRequestModel | undefined;
  return { spec: model?.spec, thinking: model?.thinking };
}

async function writeSessionDefaults(
  harness: Harness,
  sessionId: string,
  patch: { defaultModel?: string; defaultThinking?: string },
): Promise<void> {
  const writer = featureWriterOf(harnessInternals(harness.app), sessionId);
  const log = await writer.open('provider-catalog');
  await log.commit({
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
  harness: Harness,
  sessionId: string,
): Promise<SessionModelDefaults> {
  const writer = featureWriterOf(harnessInternals(harness.app), sessionId);
  const log = await writer.open('provider-catalog');
  const view = log.replica.view(sessionModelDefaultsProjection);
  const state = view.getState();
  view.dispose();
  return state;
}

describe('providerCatalog feature', () => {
  it('contributes a provider, pings through the store, and exposes a requester binding', async () => {
    let failing = true;
    const requester = fakeRequester(() => (failing ? failedOutcome('boom') : textOutcome('pong')));
    const { harness, catalog, models } = await mountCatalog(() => {
      useProvider({ handle: stubHandle('test', requester), models: [modelDef] });
    });
    await until(() => catalog.models('test').length === 1);
    await until(() => models().some((item) => item.model.id === 'm1'));
    expect(catalog.requester('test', 'm1')).toBeDefined();

    catalog.ping('test', 'm1');
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');

    failing = false;
    catalog.ping('test', 'm1');
    await until(() => catalog.models('test').at(0)?.pingError === undefined);
    await harness.close();
  });

  it('ignores pings for unknown providers and models', async () => {
    const { harness, catalog } = await mountCatalog();
    catalog.upsert({
      handle: stubHandle('test', failingRequester('boom')),
      models: [modelDef].map(catalogModelDefinitionOf),
    });
    await until(() => catalog.models('test').length === 1);

    catalog.ping('nope', 'm1');
    catalog.ping('test', 'nope');
    await sleep(5);

    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();
    expect(catalog.requester('nope', 'm1')).toBeUndefined();
    await harness.close();
  });

  it('pings through the latest provider instance after a re-upsert', async () => {
    const { harness, catalog } = await mountCatalog();
    catalog.upsert({
      handle: stubHandle('test', failingRequester('first')),
      models: [modelDef].map(catalogModelDefinitionOf),
    });
    catalog.upsert({
      handle: stubHandle('test', failingRequester('second')),
      models: [modelDef].map(catalogModelDefinitionOf),
    });

    catalog.ping('test', 'm1');

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
    catalog.upsert({
      handle,
      models: [{ ...modelDef, protocol: 'anthropic', betaApi: true }].map(catalogModelDefinitionOf),
    });

    catalog.ping('test', 'm1');
    await until(() => seen.length > 0);
    expect(seen[0]?.name).toBe('m1');
    expect(catalog.models('test').at(0)?.protocolOptions?.['betaApi']).toBe(true);
    expect(catalog.requester('test', 'm1')).toBeDefined();
    await harness.close();
  });

  it('defers a ping sent while refreshing until the refresh completes', async () => {
    let pulls = 0;
    let resolvePull: (models: readonly CatalogModelConfig[]) => void = () => {};
    const provider = stubHandle('test', failingRequester('boom'), () => {
      pulls += 1;
      return new Promise((resolve) => {
        resolvePull = resolve;
      });
    });
    const { harness, catalog } = await mountCatalog();
    catalog.upsert({ handle: provider, models: [modelDef].map(catalogModelDefinitionOf) });
    await until(() => pulls === 1);

    catalog.ping('test', 'm1');
    await sleep(5);
    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();

    resolvePull([]);
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');
    await harness.close();
  });
});

describe('providerCatalog config integration', () => {
  it('syncs config sections into the catalog and reacts to config changes', async () => {
    const { harness, config, catalog, file } = await mountWithConfig(
      '[providers.ghost]\nbase_url = "https://api.example.com"\ndefault_model = "g1"\n\n[models.g1]\nprovider = "ghost"\nmodel = "g1"\n',
    );
    await until(() => catalog.providers().includes('ghost'));
    expect(catalog.providerInfo('ghost')?.baseUrl).toBe('https://api.example.com');
    expect(catalog.models('ghost').map((model) => model.id)).toEqual(['g1']);

    await config.set(
      'providers',
      { ghost: { baseUrl: 'https://v2.example.com', defaultModel: 'g1' } },
      'memory',
    );
    await until(() => catalog.providerInfo('ghost')?.baseUrl === 'https://v2.example.com');

    await config.replace({ providers: {}, models: {} }, 'memory');
    await until(() => !catalog.providers().includes('ghost'));
    expect(file.saved).toHaveLength(0);
    await harness.close();
  });

  it('writes discovered models under provider-prefixed aliases, rebuilds the generated zone on refresh, and preserves user aliases', async () => {
    let upstream: readonly CatalogModelConfig[] = [
      { provider: 'test', model: 'm1', capability: testCapability(false), maxContextSize: 4096 },
      { provider: 'test', model: 'm2', capability: testCapability(false), maxContextSize: 4096 },
    ];
    const provider = stubHandle('test', failingRequester('boom'), () => Promise.resolve(upstream));
    const { harness, catalog, file } = await mountWithConfig(
      '[models."my-fav"]\nprovider = "test"\nmodel = "m1"\ndisplay_name = "mine"\n',
      {
        contribute: () => {
          useProvider({ handle: provider, models: [modelDef] });
          useProvider({
            handle: stubHandle('test2', failingRequester('boom'), () =>
              Promise.resolve([
                { provider: 'test2', model: 'm1', capability: testCapability(false), maxContextSize: 8192 },
              ]),
            ),
          });
        },
      },
    );
    const readModels = (): Record<string, Record<string, unknown>> =>
      (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> }).models;
    await until(() => file.saved.length > 0 && readModels()['test2/m1'] !== undefined);
    expect(readModels()['test/m1']).toMatchObject({
      provider: 'test',
      model: 'm1',
      max_context_size: 4096,
    });
    expect(readModels()['test/m2']).toMatchObject({ provider: 'test', model: 'm2' });
    expect(readModels()['test2/m1']).toMatchObject({
      provider: 'test2',
      model: 'm1',
      max_context_size: 8192,
    });
    expect(readModels()['my-fav']).toMatchObject({
      provider: 'test',
      model: 'm1',
      display_name: 'mine',
    });

    upstream = [{ provider: 'test', model: 'm2', capability: testCapability(false), maxContextSize: 4096 }];
    catalog.refresh(provider);
    await until(() => readModels()['test/m1'] === undefined);
    expect(readModels()['test/m2']).toBeDefined();
    expect(readModels()['test2/m1']).toBeDefined();
    expect(readModels()['my-fav']).toBeDefined();

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
    await harness.close();
  });

  it('prefers config-sourced info and models over contributed ones on conflict', async () => {
    const { harness, catalog } = await mountWithConfig(
      '[providers.test]\nbase_url = "https://config.example.com"\n',
      {
        contribute: () => {
          useProvider({
            handle: stubHandle('test', failingRequester('boom')),
            info: { baseUrl: 'https://contributed.example.com' },
            models: [modelDef],
          });
        },
      },
    );
    await until(() => catalog.providers().includes('test'));
    await until(() => catalog.providerInfo('test')?.baseUrl === 'https://config.example.com');
    expect(catalog.models('test')).toEqual([]);
    await harness.close();
  });

  it('loads a v2-format file with [model_catalog] and a capabilities array, then writes the same format back', async () => {
    const { harness, config, catalog, file } = await mountWithConfig(
      '[model_catalog]\nrefresh_interval_ms = 60000\nrefresh_on_start = false\n\n' +
        '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmax_context_size = 4096\ncapabilities = [ "image_in", "tool_use" ]\n',
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
    await config.replace(
      { models: { 'test/m1': { ...loaded['test/m1'], maxContextSize: 8192 } } },
      'user',
    );
    const text = file.saved.at(-1)!;
    expect(text).toContain('[model_catalog]');
    expect(text).toContain('refresh_interval_ms = 60000');
    const models = (parseToml(text) as { models: Record<string, Record<string, unknown>> }).models;
    expect(models['test/m1']).toMatchObject({
      provider: 'test',
      model: 'm1',
      max_context_size: 8192,
      capabilities: ['image_in', 'tool_use'],
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
  it('materializes a config-declared provider, discovers models, writes them back under the alias scope, and unbinds on removal', async () => {
    const seen: { url: string; authorization?: string }[] = [];
    let upstream: readonly string[] = ['m1', 'm2'];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: typeof input === 'string' ? input : input.url,
        authorization: (init?.headers as Record<string, string> | undefined)?.['authorization'],
      });
      return new Response(JSON.stringify({ data: upstream.map((id) => ({ id })) }), {
        status: 200,
      });
    });
    try {
      const { harness, config, catalog, file } = await mountWithConfig(
        '[providers.acme]\ntype = "acme"\nbase_url = "https://acme.example.com"\nmodel_source = "discover"\nalias_scope = "shared"\n\n[providers.acme.env]\napiKey = "ACME_KEY"\n',
        {
          env: { ACME_KEY: 'sk-resolved' },
          contribute: () => {
            useProviderProtocol({
              type: 'acme',
              protocols: () => ({ openai: openAIRequester }),
            });
          },
        },
      );
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
      await until(() => file.saved.length > 0 && readModels()['shared/m2'] !== undefined);
      expect(readModels()['shared/m1']).toMatchObject({ provider: 'acme', model: 'm1' });
      expect(readModels()['shared/m2']).toMatchObject({ provider: 'acme', model: 'm2' });
      expect(readModels()['shared/m1']!['api_key']).toBeUndefined();

      upstream = ['m2'];
      catalog.refresh('acme');
      await until(() => readModels()['shared/m1'] === undefined);
      expect(readModels()['shared/m2']).toBeDefined();

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

  it('does not fetch models for static providers and skips oauth-backed and unknown types', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { harness, catalog } = await mountWithConfig(
        '[providers.acme]\ntype = "acme"\nbase_url = "https://acme.example.com"\napi_key = "sk-x"\n\n[providers.managed]\ntype = "acme"\nmodel_source = "oauth-catalog"\nbase_url = "https://managed.example.com"\n\n[providers.legacy]\ntype = "acme"\nbase_url = "https://legacy.example.com"\n\n[providers.legacy.oauth]\nstorage = "file"\nkey = "oauth/legacy"\n\n[providers.ghost]\ntype = "nope"\nbase_url = "https://ghost.example.com"\n',
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
      expect(catalog.isLive('managed')).toBe(false);
      expect(catalog.isLive('legacy')).toBe(false);
      expect(catalog.isLive('ghost')).toBe(false);
      await harness.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('provider-catalog credential resolvers', () => {
  it('resolves contributed resolvers before the static apiKey fallback', async () => {
    const sentinel: LlmCredentialProvider = { resolve: () => ({ apiKey: 'sk-sentinel' }) };
    const { harness, capture } = await mountWithConfig(undefined, {
      env: { ACME_KEY: 'sk-env' },
      contribute: () => {
        useCredentialResolver({
          resolve: (info) => (info.type === 'sentinel' ? sentinel : undefined),
        });
      },
    });
    const resolvers = capture.credentials?.value ?? [];
    expect(await resolveCredentialProvider({ apiKey: 'sk-inline' }, resolvers)?.resolve()).toEqual({
      apiKey: 'sk-inline',
    });
    expect(
      await resolveCredentialProvider({ env: { apiKey: 'ACME_KEY' } }, resolvers)?.resolve(),
    ).toEqual({ apiKey: 'sk-env' });
    expect(resolveCredentialProvider({ type: 'sentinel', apiKey: 'sk-x' }, resolvers)).toBe(
      sentinel,
    );
    expect(resolveCredentialProvider({}, resolvers)).toBeUndefined();
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
    const session = await harness.app.create({ sessionId: 'sess' });
    await harness.ensureAgent(session, 'main');
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
    const session = await harness.app.create({ sessionId: 'sess' });
    await harness.ensureAgent(session, 'main');
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
  readonly harness: Harness;
  readonly session: Awaited<ReturnType<Harness['app']['create']>>;
  readonly main: Awaited<ReturnType<Harness['ensureAgent']>>;
  readonly file: { saved: string[]; persist: ConfigPersist };
  readonly config: ConfigStore;
  readonly capture: ProbeCapture;
  readonly seen: { m1: SeenCall[]; m2: SeenCall[] };
}

async function mountFixture(initial?: string): Promise<ModelFixture> {
  const file = fakePersist(initial);
  const seen = { m1: [] as SeenCall[], m2: [] as SeenCall[] };
  const capture: ProbeCapture = {};
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(providerCatalog);
  harness.app.features.add(createConfig({ persist: file.persist }));
  harness.app.features.add(
    catalogProbe(capture, () => {
      useProvider({
        handle: stubHandle('test', textRequester(seen.m1)),
        info: { apiKey: 'sk-test' },
        models: [m1Def],
      });
      useProvider({
        handle: stubHandle('other', textRequester(seen.m2)),
        info: { apiKey: 'sk-other' },
        models: [m2Def],
      });
    }),
  );
  await tick();
  const config = capture.config?.value;
  if (config === undefined) throw new Error('config store was not exposed');
  await config.reload();
  const session = await harness.app.create({ sessionId: 'sess' });
  const main = await harness.ensureAgent(session, 'main');
  return { harness, session, main, file, config, capture, seen };
}

describe('provider-catalog app model defaults', () => {
  it('persists the default model to the user config target as a snake_case scalar', async () => {
    const { harness, file, capture } = await mountFixture();
    await until(() => (capture.models?.value.length ?? 0) === 2);
    const defaults = capture.defaults?.value;
    if (defaults === undefined) throw new Error('model defaults face was not exposed');
    await defaults.setDefaultModel('other/m2');
    expect(file.saved.at(-1)).toContain('default_model = "other/m2"');
    await harness.close();
  });

  it('edits an existing default_model scalar in place and keeps its trailing comment', async () => {
    const { harness, file, capture } = await mountFixture('default_model = "test/m1"   # current pick\n');
    await until(() => (capture.models?.value.length ?? 0) === 2);
    const defaults = capture.defaults?.value;
    if (defaults === undefined) throw new Error('model defaults face was not exposed');
    await defaults.setDefaultModel('other/m2');
    expect(file.saved.at(-1)).toBe('default_model = "other/m2"   # current pick\n');
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
    const harness = createHarness({ space: memoryHarnessSpace() });
    harness.app.features.add(providerCatalog);
    harness.app.features.add(
      catalogProbe(capture, () => {
        useProvider({ handle: stubHandle('test', textRequester([])), models: [m1Def] });
      }),
    );
    await tick();
    await until(() => (capture.models?.value.length ?? 0) === 1);
    const defaults = capture.defaults?.value;
    if (defaults === undefined) throw new Error('model defaults face was not exposed');
    await expect(defaults.setDefaultModel('test/m1')).rejects.toMatchObject({
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
    await session.close('main');
    await harness.ensureAgent(session, 'main');
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
    const { harness, session, capture } = await mountFixture('default_model = "test/m1"\n');
    await until(() => boundModel(harness, 'sess', 'main').spec?.name === 'm1');
    const face = capture.agentFace;
    if (face === undefined) throw new Error('agent model face was not captured');
    await expect(face.setThinking('turbo')).rejects.toMatchObject({
      code: 'model.invalid_thinking',
    });
    await face.setThinking('high');
    await until(() => boundModel(harness, 'sess', 'main').thinking?.effort === 'high');
    expect(face.current.value).toEqual({ alias: null, thinking: 'high' });
    await session.close('main');
    await harness.ensureAgent(session, 'main');
    await until(() => boundModel(harness, 'sess', 'main').thinking?.effort === 'high');
    expect(boundModel(harness, 'sess', 'main').spec?.name).toBe('m1');
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
    const space = memoryHarnessSpace();
    const file = fakePersist('default_model = "test/m1"\n');
    const seen = { m1: [] as SeenCall[], m2: [] as SeenCall[] };
    const mount = async (): Promise<{ harness: Harness; capture: ProbeCapture }> => {
      const capture: ProbeCapture = {};
      const harness = createHarness({ space });
      harness.app.features.add(providerCatalog);
      harness.app.features.add(createConfig({ persist: file.persist }));
      harness.app.features.add(
        catalogProbe(capture, () => {
          useProvider({
            handle: stubHandle('test', textRequester(seen.m1)),
            info: { apiKey: 'sk-test' },
            models: [m1Def],
          });
          useProvider({
            handle: stubHandle('other', textRequester(seen.m2)),
            info: { apiKey: 'sk-other' },
            models: [m2Def],
          });
        }),
      );
      await tick();
      const config = capture.config?.value;
      if (config === undefined) throw new Error('config store was not exposed');
      await config.reload();
      return { harness, capture };
    };
    const first = await mount();
    const session = await first.harness.app.create({ sessionId: 'sess' });
    await first.harness.ensureAgent(session, 'main');
    await until(() => boundModel(first.harness, 'sess', 'main').spec?.name === 'm1');
    const face = first.capture.sessionFace;
    if (face === undefined) throw new Error('session model face was not captured');
    await face.setModel('other/m2');
    await until(() => boundModel(first.harness, 'sess', 'main').spec?.name === 'm2');
    await first.harness.close();

    const second = await mount();
    const resumed = await second.harness.app.create({ sessionId: 'sess' });
    await second.harness.ensureAgent(resumed, 'main');
    await until(() => boundModel(second.harness, 'sess', 'main').spec?.name === 'm2');
    await second.harness.close();
  });
});
