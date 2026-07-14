import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AgentProfileService } from '#/agent/profile/profileService';
import { ProfileModel } from '#/agent/profile/profileOps';
import { DEFAULT_AGENT_PROFILE_NAME, IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import type { GenerationKwargs } from '#/app/llmProtocol/kimiOptions';
import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { type LLMEvent, type Model } from '#/app/model/modelInstance';
import { IModelResolver } from '#/app/model/modelResolver';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { AgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContextService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

const SCOPE = 'wire';
const KEY = 'profile-test';

function createTelemetryStub(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: () => undefined,
    track2: () => undefined,
  } as unknown as ITelemetryService;
}

function createConfigStub(): IConfigService {
  return {
    _serviceBrand: undefined,
    get: ((key: string) => configValues[key]) as unknown as IConfigService['get'],
  } as unknown as IConfigService;
}

function createModelResolverStub(): IModelResolver {
  return {
    _serviceBrand: undefined,
    resolve: () => {
      throw new Error('not exercised');
    },
  } as unknown as IModelResolver;
}

function stubUnused<T>(): T {
  return { _serviceBrand: undefined } as unknown as T;
}

function createSessionContextStub(): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 'session-test',
    workspaceId: 'workspace-test',
    sessionDir: '/tmp/session-test',
    metaScope: 'sessions/workspace-test/session-test',
    cwd: '/tmp',
    scope: (subKey?: string) =>
      subKey === undefined || subKey.length === 0
        ? 'sessions/workspace-test/session-test'
        : `sessions/workspace-test/session-test/${subKey}`,
  };
}

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let wire: IWireService;
let svc: IAgentProfileService;
let configValues: Record<string, unknown>;
let modelResolver: IModelResolver;

function buildHost(key: string): {
  ix: TestInstantiationService;
  wire: IWireService;
  svc: IAgentProfileService;
  log: IAppendLogStore;
} {
  const host = disposables.add(new TestInstantiationService());
  host.stub(IFileSystemStorageService, new InMemoryStorageService());
  host.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  host.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: key }]));
  host.stub(ITelemetryService, createTelemetryStub());
  host.stub(IAgentTelemetryContextService, new AgentTelemetryContextService());
  host.stub(IConfigService, createConfigStub());
  host.stub(IModelResolver, modelResolver);
  host.stub(IHostEnvironment, stubUnused());
  host.stub(IHostFileSystem, stubUnused());
  host.stub(IBootstrapService, stubUnused());
  host.stub(ISessionContext, createSessionContextStub());
  host.stub(ISessionWorkspaceContext, stubUnused());
  host.stub(IAgentProfileCatalogService, stubUnused());
  host.stub(ISessionSkillCatalog, stubUnused());
  host.set(IAgentProfileService, new SyncDescriptor(AgentProfileService));
  return {
    ix: host,
    wire: host.get(IAgentWireService),
    svc: host.get(IAgentProfileService),
    log: host.get(IAppendLogStore),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  configValues = {};
  modelResolver = createModelResolverStub();
  const host = buildHost(KEY);
  ix = host.ix;
  wire = host.wire;
  svc = host.svc;
  log = host.log;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, key)) {
    out.push(record);
  }
  return out;
}

function modelOf(target: IWireService) {
  return target.getModel(ProfileModel);
}

function createRecordingModel(
  generationKwargs: GenerationKwargs[],
  thinkingEfforts: ThinkingEffort[],
  providerOptions: unknown[] = [],
  protocol: Model['protocol'] = 'kimi',
  thinkingKeeps: string[] = [],
): Model {
  const build = (thinkingEffort: ThinkingEffort | null): Model => ({
    id: 'kimi-code',
    name: 'kimi-for-coding',
    aliases: [],
    protocol,
    baseUrl: 'https://example.test/v1',
    headers: {},
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: true,
      tool_use: false,
      max_context_tokens: 1000,
    },
    maxContextSize: 1000,
    thinkingEffort,
    alwaysThinking: false,
    providerName: 'kimi',
    authProvider: { getAuth: async () => undefined },
    withThinking: (effort) => {
      thinkingEfforts.push(effort);
      return build(effort);
    },
    withMaxCompletionTokens: () => build(thinkingEffort),
    withGenerationKwargs: (kwargs) => {
      generationKwargs.push(kwargs);
      return build(thinkingEffort);
    },
    withProviderOptions: (options) => {
      providerOptions.push(options);
      return build(thinkingEffort);
    },
    withThinkingKeep: (keep) => {
      thinkingKeeps.push(keep);
      return build(thinkingEffort);
    },
    request: async function* () {
      const events: LLMEvent[] = [];
      for (const event of events) yield event;
    },
  });
  return build(null);
}

describe('AgentProfileService (wire-backed config.update)', () => {
  it('update persists a flat config.update record and resolves thinkingLevel as wire thinkingEffort at the call site', async () => {
    svc.update({ profileName: DEFAULT_AGENT_PROFILE_NAME, systemPrompt: 'You are helpful.' });
    svc.update({ thinkingLevel: 'on' });

    const model = modelOf(wire);
    expect(model.profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(model.systemPrompt).toBe('You are helpful.');
    expect(model.thinkingLevel).toBe('on');
    expect(svc.getSystemPrompt()).toBe('You are helpful.');

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'config.update',
        profileName: DEFAULT_AGENT_PROFILE_NAME,
        systemPrompt: 'You are helpful.',
        time: expect.any(Number),
      },
      { type: 'config.update', thinkingEffort: 'on', time: expect.any(Number) },
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
  });

  it('re-dispatching an equal config is a no-op on the model (same reference)', () => {
    svc.update({ profileName: DEFAULT_AGENT_PROFILE_NAME });
    const before = modelOf(wire);
    svc.update({ profileName: DEFAULT_AGENT_PROFILE_NAME });
    expect(modelOf(wire)).toBe(before);
  });

  it('chdir and emitStatusUpdated run live-only and are silent during replay', async () => {
    let chdirCalls = 0;
    let statusEmits = 0;
    svc.configure({
      chdir: () => {
        chdirCalls += 1;
      },
      emitStatusUpdated: () => {
        statusEmits += 1;
      },
    });

    svc.update({ cwd: '/work', profileName: DEFAULT_AGENT_PROFILE_NAME });
    expect(chdirCalls).toBe(1);
    expect(statusEmits).toBe(1);

    const records = await readRecords();

    const host = buildHost('profile-replay');
    let replayChdir = 0;
    let replayEmits = 0;
    host.svc.configure({
      chdir: () => {
        replayChdir += 1;
      },
      emitStatusUpdated: () => {
        replayEmits += 1;
      },
    });

    await host.wire.replay(...records);
    expect(modelOf(host.wire).cwd).toBe('/work');
    expect(modelOf(host.wire).profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(replayChdir).toBe(0);
    expect(replayEmits).toBe(0);

    const written: PersistedRecord[] = [];
    for await (const record of host.log.read<PersistedRecord>(SCOPE, 'profile-replay')) {
      written.push(record);
    }
    expect(written).toEqual([]);
  });

  it('replay rebuilds the resolved thinkingLevel without re-reading config', async () => {
    svc.update({ thinkingLevel: 'on' });
    const records = await readRecords();

    const host = buildHost('profile-replay-thinking');
    await host.wire.replay(...records);
    expect(modelOf(host.wire).thinkingLevel).toBe('on');
  });

  it('replays legacy config.update thinkingLevel records', async () => {
    const host = buildHost('profile-replay-legacy-thinking-level');

    await host.wire.replay({ type: 'config.update', thinkingLevel: 'high' });

    expect(modelOf(host.wire).thinkingLevel).toBe('high');
  });

  it('rejects conflicting config.update thinking aliases during replay', async () => {
    const host = buildHost('profile-replay-conflicting-thinking-aliases');

    await expect(
      host.wire.replay({ type: 'config.update', thinkingEffort: 'low', thinkingLevel: 'high' }),
    ).rejects.toMatchObject({
      code: 'profile.thinking_alias_conflict',
      name: 'ProfileError',
    });
  });

  it('applies thinking.keep model override when thinking is enabled', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () => createRecordingModel(generationKwargs, thinkingEfforts),
      findByName: () => [],
    };
    const host = buildHost('profile-thinking-keep');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['modelOverrides'] = { temperature: 0.3, thinkingKeep: 'all' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    const model = host.svc.resolveModel();

    expect(model?.thinkingEffort).toBe('high');
    expect(thinkingEfforts).toEqual(['high']);
    expect(generationKwargs).toEqual([
      {
        prompt_cache_key: 'session-test',
        temperature: 0.3,
        extra_body: { thinking: { keep: 'all' } },
      },
    ]);
  });

  it('forces configured Kimi thinking effort outside declared support_efforts', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () => createRecordingModel(generationKwargs, thinkingEfforts),
      findByName: () => [],
    };
    const host = buildHost('profile-thinking-effort-force');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['thinking'] = { effort: ' max ' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'on' });
    const model = host.svc.resolveModel();

    expect(model?.thinkingEffort).toBe('max');
    expect(thinkingEfforts).toEqual(['max']);
    expect(generationKwargs).toEqual([
      { prompt_cache_key: 'session-test' },
      { extra_body: { thinking: { type: 'enabled', effort: 'max', keep: 'all' } } },
    ]);
  });

  it('applies thinking.keep model override on the Anthropic path', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    const providerOptions: unknown[] = [];
    const thinkingKeeps: string[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () =>
        createRecordingModel(
          generationKwargs,
          thinkingEfforts,
          providerOptions,
          'anthropic',
          thinkingKeeps,
        ),
      findByName: () => [],
    };
    const host = buildHost('profile-thinking-keep-anthropic');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['modelOverrides'] = { temperature: 0.3, thinkingKeep: 'all' };

    host.svc.update({ modelAlias: 'claude-code', thinkingLevel: 'high' });
    const model = host.svc.resolveModel();

    expect(model?.thinkingEffort).toBe('high');
    expect(thinkingEfforts).toEqual(['high']);
    expect(thinkingKeeps).toEqual(['all']);
    expect(providerOptions).toEqual([{ metadata: { user_id: 'session-test' } }]);
    expect(generationKwargs).toEqual([{ temperature: 0.3 }]);
  });

  it('defaults thinking.keep to "all" when thinking is enabled on Kimi', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () => createRecordingModel(generationKwargs, thinkingEfforts),
      findByName: () => [],
    };
    const host = buildHost('profile-thinking-keep-default');
    host.svc.configure({ emitStatusUpdated: () => undefined });

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    host.svc.resolveModel();

    expect(generationKwargs).toEqual([
      { prompt_cache_key: 'session-test', extra_body: { thinking: { keep: 'all' } } },
    ]);
  });

  it('treats an off env thinking.keep override as disabled on Kimi', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () => createRecordingModel(generationKwargs, thinkingEfforts),
      findByName: () => [],
    };
    const host = buildHost('profile-thinking-keep-env-off');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['modelOverrides'] = { thinkingKeep: 'off' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    host.svc.resolveModel();

    expect(generationKwargs).toEqual([{ prompt_cache_key: 'session-test' }]);
  });

  it('applies config thinking.keep on the Anthropic path', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    const providerOptions: unknown[] = [];
    const thinkingKeeps: string[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () =>
        createRecordingModel(
          generationKwargs,
          thinkingEfforts,
          providerOptions,
          'anthropic',
          thinkingKeeps,
        ),
      findByName: () => [],
    };
    const host = buildHost('profile-thinking-keep-anthropic-config');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['thinking'] = { keep: 'config-keep' };

    host.svc.update({ modelAlias: 'claude-code', thinkingLevel: 'high' });
    const model = host.svc.resolveModel();

    expect(model?.thinkingEffort).toBe('high');
    expect(thinkingKeeps).toEqual(['config-keep']);
    expect(generationKwargs).toEqual([]);
  });

  it('does not apply thinking.keep model override when thinking is off', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () => createRecordingModel(generationKwargs, thinkingEfforts),
      findByName: () => [],
    };
    const host = buildHost('profile-thinking-keep-off');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['modelOverrides'] = { temperature: 0.3, thinkingKeep: 'all' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'off' });
    host.svc.resolveModel();

    expect(thinkingEfforts).toEqual(['off']);
    expect(generationKwargs).toEqual([{ prompt_cache_key: 'session-test', temperature: 0.3 }]);
  });

  it('uses the session id as a Kimi prompt cache hint', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () => createRecordingModel(generationKwargs, thinkingEfforts),
      findByName: () => [],
    };
    const host = buildHost('profile-prompt-cache-key');
    host.svc.configure({ emitStatusUpdated: () => undefined });

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    host.svc.resolveModel();

    expect(thinkingEfforts).toEqual(['high']);
    expect(generationKwargs).toEqual([
      { prompt_cache_key: 'session-test', extra_body: { thinking: { keep: 'all' } } },
    ]);
  });

  it('does not apply the Kimi prompt cache hint to other protocols', () => {
    const generationKwargs: GenerationKwargs[] = [];
    const thinkingEfforts: ThinkingEffort[] = [];
    const providerOptions: unknown[] = [];
    modelResolver = {
      _serviceBrand: undefined,
      resolve: () =>
        createRecordingModel(generationKwargs, thinkingEfforts, providerOptions, 'anthropic'),
      findByName: () => [],
    };
    const host = buildHost('profile-prompt-cache-key-anthropic');
    host.svc.configure({ emitStatusUpdated: () => undefined });

    host.svc.update({ modelAlias: 'claude-sonnet', thinkingLevel: 'high' });
    host.svc.resolveModel();

    expect(thinkingEfforts).toEqual(['high']);
    expect(generationKwargs).toEqual([]);
    expect(providerOptions).toEqual([{ metadata: { user_id: 'session-test' } }]);
  });
});
