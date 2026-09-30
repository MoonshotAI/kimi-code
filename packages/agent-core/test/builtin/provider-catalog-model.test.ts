import { describe, expect, it } from 'vitest';

import {
  memorySessionSpace,
  createHarness,
  type AgentHandle,
  type AppHandle,
  type SessionHandle,
  type SessionSpace,
} from '#/app/index';
import {
  AgentModelRef,
  CatalogModels,
  ModelDefaultsRef,
  SessionModelRef,
  providerCatalog,
  useProvider,
  type CatalogModelDefinition,
} from '#/builtin/provider-catalog/index';
import { ConfigRef, createConfig, type ConfigPersist } from '#/builtin/config/index';
import { createFeature } from '#/feature/index';
import { createUserMessage } from '#/llm/message';
import type { LlmModel, ModelCapability } from '#/llm/model';
import type { Provider } from '#/llm/provider';
import type { LlmRequester } from '#/llm/requester/requester';

function thinkingCapability(thinking: boolean): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking,
    tool_use: true,
  };
}

const m1Def: CatalogModelDefinition = {
  provider: 'test',
  model: 'm1',
  capability: thinkingCapability(true),
  maxContextSize: 4096,
  supportEfforts: ['low', 'high'],
  defaultEffort: 'low',
};

const m2Def: CatalogModelDefinition = {
  provider: 'other',
  model: 'm2',
  capability: thinkingCapability(false),
  maxContextSize: 8192,
};

function stubProvider(id: string, requester: LlmRequester): Provider {
  return {
    id,
    requesters: { openai: requester },
    listModels: () => Promise.resolve([]),
    resolveModel: () => {
      throw new Error('unused');
    },
  };
}

function textRequester(seen: LlmModel[]): LlmRequester {
  return {
    generate: (config, _content, { onEvent }) => {
      seen.push(config.model);
      onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
      onEvent?.({ type: 'llm.done' });
      return Promise.resolve();
    },
  };
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

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

function turnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

interface Fixture {
  readonly app: AppHandle;
  readonly session: SessionHandle;
  readonly main: AgentHandle;
  readonly file: { saved: string[]; persist: ConfigPersist };
  readonly space: SessionSpace;
  readonly seen: { m1: LlmModel[]; m2: LlmModel[] };
}

async function mountFixture(initial?: string): Promise<Fixture> {
  const file = fakePersist(initial);
  const space = memorySessionSpace();
  const seen = { m1: [] as LlmModel[], m2: [] as LlmModel[] };
  const app = createHarness({
    space,
    features: [
      createConfig({ persist: file.persist }),
      providerCatalog,
      createFeature('probe', {
        app() {
          useProvider({
            provider: stubProvider('test', textRequester(seen.m1)),
            info: { apiKey: 'sk-test' },
            models: [m1Def],
          });
          useProvider({
            provider: stubProvider('other', textRequester(seen.m2)),
            info: { apiKey: 'sk-other' },
            models: [m2Def],
          });
        },
      }),
    ],
  });
  await app.ready();
  const session = await app.open({ sessionId: 'sess' });
  const main = await session.create({ agentId: 'main' });
  return { app, session, main, file, space, seen };
}

describe('provider-catalog app model defaults', () => {
  it('persists the default model to the user config target as a snake_case scalar', async () => {
    const { app, file } = await mountFixture();
    await until(() => app.node.fold(CatalogModels).length === 2);
    await app.resolve(ModelDefaultsRef).setDefaultModel('other/m2');
    expect(file.saved.at(-1)).toContain('default_model = "other/m2"');
    await app.disposeAsync();
  });

  it('edits an existing default_model scalar in place and keeps its trailing comment', async () => {
    const { app, file } = await mountFixture('default_model = "test/m1"   # current pick\n');
    await until(() => app.node.fold(CatalogModels).length === 2);
    await app.resolve(ModelDefaultsRef).setDefaultModel('other/m2');
    expect(file.saved.at(-1)).toBe('default_model = "other/m2"   # current pick\n');
    await app.disposeAsync();
  });

  it('rejects an unknown alias with a coded error', async () => {
    const { app } = await mountFixture();
    await until(() => app.node.fold(CatalogModels).length === 2);
    await expect(app.resolve(ModelDefaultsRef).setDefaultModel('ghost/nope')).rejects.toMatchObject(
      { code: 'model.unknown_alias' },
    );
    await app.disposeAsync();
  });

  it('rejects when the config feature is not mounted', async () => {
    const app = createHarness({
      space: memorySessionSpace(),
      features: [
        providerCatalog,
        createFeature('probe', {
          app() {
            useProvider({ provider: stubProvider('test', textRequester([])), models: [m1Def] });
          },
        }),
      ],
    });
    await app.ready();
    await until(() => app.node.fold(CatalogModels).length === 1);
    await expect(app.resolve(ModelDefaultsRef).setDefaultModel('test/m1')).rejects.toMatchObject({
      code: 'config.unavailable',
    });
    await app.disposeAsync();
  });

  it('merges the default thinking effort without persisting the env-forced effort', async () => {
    const file = fakePersist();
    const app = createHarness({
      space: memorySessionSpace(),
      features: [
        createConfig({ persist: file.persist, env: { KIMI_MODEL_THINKING_EFFORT: 'low' } }),
        providerCatalog,
      ],
    });
    await app.ready();
    expect(app.resolve(ConfigRef).get<{ forcedEffort?: string }>('thinking').forcedEffort).toBe(
      'low',
    );
    await app.resolve(ModelDefaultsRef).setDefaultThinking('high');
    const text = file.saved.at(-1)!;
    expect(text).toContain('effort = "high"');
    expect(text).not.toContain('forcedEffort');
    expect(text).not.toContain('forced_effort');
    await app.disposeAsync();
  });
});

describe('provider-catalog agent model binding', () => {
  it('binds config, requester and credential atomically and records the binding', async () => {
    const { app, main, seen } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    const face = main.resolve(AgentModelRef);
    await face.setModel('other/m2');
    await until(() => main.config?.model.model === 'm2');
    expect(face.current.value).toEqual({ alias: 'other/m2', thinking: null });
    const done = turnDone(main);
    main.submit(createUserMessage('hi'));
    await done;
    expect(seen.m1).toHaveLength(0);
    expect(seen.m2.at(-1)?.model).toBe('m2');
    expect(seen.m2.at(-1)?.apiKey).toBe('sk-other');
    await app.disposeAsync();
  });

  it('restores the durable binding on remount ahead of app defaults', async () => {
    const { app, session, main } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    await main.resolve(AgentModelRef).setModel('other/m2');
    await until(() => main.config?.model.model === 'm2');
    await session.close('main');
    const remounted = await session.create({ agentId: 'main' });
    await until(() => remounted.config?.model.model === 'm2');
    expect(remounted.resolve(AgentModelRef).current.value).toEqual({
      alias: 'other/m2',
      thinking: null,
    });
    await app.disposeAsync();
  });

  it('binds the app-level default model when no session or agent default exists', async () => {
    const { app, main } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    expect(main.config?.model.maxContextSize).toBe(4096);
    await app.disposeAsync();
  });

  it('prefers session defaults over the app default', async () => {
    const { app, main } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    await app.updateSession('sess', { metadata: { defaultModel: 'other/m2' } });
    await until(() => main.config?.model.model === 'm2');
    await app.resolve(ConfigRef).set('defaultModel', 'test/m1', 'user');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(main.config?.model.model).toBe('m2');
    await app.disposeAsync();
  });

  it('prefers the agent binding over session defaults', async () => {
    const { app, main } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    await main.resolve(AgentModelRef).setModel('other/m2');
    await until(() => main.config?.model.model === 'm2');
    await app.updateSession('sess', { metadata: { defaultModel: 'test/m1' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(main.config?.model.model).toBe('m2');
    await app.disposeAsync();
  });

  it('rebinds a live agent when the session default changes', async () => {
    const { app, main, seen } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    await app.updateSession('sess', { metadata: { defaultModel: 'other/m2' } });
    await until(() => main.config?.model.model === 'm2');
    const done = turnDone(main);
    main.submit(createUserMessage('hi'));
    await done;
    expect(seen.m1).toHaveLength(0);
    expect(seen.m2.at(-1)?.apiKey).toBe('sk-other');
    await app.disposeAsync();
  });

  it('keeps the current binding silently when the effective alias cannot be resolved', async () => {
    const { app, main } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    await app.updateSession('sess', { metadata: { defaultModel: 'ghost/nope' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(main.config?.model.model).toBe('m1');
    await app.disposeAsync();
  });

  it('stops managing an agent after an external setConfig', async () => {
    const { app, main } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    main.setConfig({
      model: { provider: 'test', model: 'custom', capability: thinkingCapability(true) },
    });
    await app.updateSession('sess', { metadata: { defaultModel: 'other/m2' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(main.config?.model.model).toBe('custom');
    await app.resolve(ConfigRef).set('defaultModel', 'other/m2', 'user');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(main.config?.model.model).toBe('custom');
    await app.disposeAsync();
  });
});

describe('provider-catalog agent thinking effort', () => {
  it('rejects an unsupported effort and applies a valid one durably', async () => {
    const { app, session, main } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    const face = main.resolve(AgentModelRef);
    await expect(face.setThinking('turbo')).rejects.toMatchObject({
      code: 'model.invalid_thinking',
    });
    await face.setThinking('high');
    await until(() => main.config?.thinking?.effort === 'high');
    expect(face.current.value).toEqual({ alias: null, thinking: 'high' });
    await session.close('main');
    const remounted = await session.create({ agentId: 'main' });
    await until(() => remounted.config?.thinking?.effort === 'high');
    expect(remounted.config?.model.model).toBe('m1');
    await app.disposeAsync();
  });

  it('rejects thinking efforts for a model without thinking support', async () => {
    const { app, main } = await mountFixture('default_model = "other/m2"\n');
    await until(() => main.config?.model.model === 'm2');
    await expect(main.resolve(AgentModelRef).setThinking('high')).rejects.toMatchObject({
      code: 'model.invalid_thinking',
    });
    await app.disposeAsync();
  });
});

describe('provider-catalog session model defaults', () => {
  it('writes session metadata and binds the live main agent', async () => {
    const { app, session, main, space } = await mountFixture('default_model = "test/m1"\n');
    await until(() => main.config?.model.model === 'm1');
    const face = session.resolve(SessionModelRef);
    await face.setThinking('high');
    expect((await space.get('sess'))?.metadata?.['defaultThinking']).toBe('high');
    await until(() => main.config?.thinking?.effort === 'high');
    await face.setModel('other/m2');
    expect((await space.get('sess'))?.metadata?.['defaultModel']).toBe('other/m2');
    await until(() => main.config?.model.model === 'm2');
    await expect(face.setThinking('low')).rejects.toMatchObject({
      code: 'model.invalid_thinking',
    });
    expect((await space.get('sess'))?.metadata?.['defaultThinking']).toBe('high');
    await expect(face.setModel('ghost/nope')).rejects.toMatchObject({
      code: 'model.unknown_alias',
    });
    await app.disposeAsync();
  });
});
