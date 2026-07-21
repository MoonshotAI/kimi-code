import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AgentProfileService } from '#/agent/profile/profileService';
import { ActiveToolsModel, ProfileModel } from '#/agent/profile/profileOps';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IProtocolAdapterRegistry, type Protocol } from '#/kosong/protocol/protocol';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { AgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContextService';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

// Side-effect registration: `drivesThinkingThroughTraits('kimi')` (used by
// the forced-effort override) answers through the provider-definition registry.
import '#/kosong/provider/providers/kimi/kimi.contrib';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

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
    onDidSectionChange: () => ({ dispose: () => {} }),
    get: ((key: string) => configValues[key]) as unknown as IConfigService['get'],
  } as unknown as IConfigService;
}

/**
 * The pure-data Model the kosong catalog hands out. No morphs: per-turn
 * intent (cache key / sampling / thinking effort+keep) now surfaces through
 * `IAgentProfileService.resolveRequestParams()` instead of `with*` call
 * records on a recording Model stub.
 */
function createTestModel(
  options: {
    readonly id?: string;
    readonly protocol?: Model['protocol'];
    readonly providerType?: string;
  } = {},
): Model {
  const providerType = options.providerType;
  return {
    id: options.id ?? 'kimi-code',
    name: 'kimi-for-coding',
    aliases: [],
    protocol: options.protocol ?? 'openai',
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
    supportEfforts: providerType === 'kimi' ? ['low', 'medium', 'high', 'max'] : undefined,
    defaultEffort: providerType === 'kimi' ? 'high' : undefined,
    alwaysThinking: false,
    providerType,
    providerName: 'kimi',
    authProvider: { getAuth: async () => undefined },
  };
}

function createModelCatalogStub(models: Readonly<Record<string, Model>> = {}): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (id) => {
      const model = models[id];
      if (model === undefined) throw new Error(`Unknown model: ${id}`);
      return model;
    },
    getRequester: () => {
      throw new Error('not exercised');
    },
    inspect: () => {
      throw new Error('not exercised');
    },
    ping: () => {
      throw new Error('not exercised');
    },
    findByName: () => [],
    listModels: () => {
      throw new Error('not exercised');
    },
    listProviders: () => {
      throw new Error('not exercised');
    },
    getProvider: () => {
      throw new Error('not exercised');
    },
    setDefaultModel: () => {
      throw new Error('not exercised');
    },
  };
}

/**
 * The one registry answer the profile reads: whether the (protocol,
 * providerType) pair drives thinking through traits, and whether that driver
 * demands strict effort validation (`strictThinkingValidation`). Mirrored
 * here from the real Kimi definitions: strict on the native openai
 * transport, lenient over anthropic, nothing on other protocols.
 */
function createProtocolRegistryStub(): IProtocolAdapterRegistry {
  return {
    _serviceBrand: undefined,
    supportedProtocols: () => ['anthropic', 'openai', 'openai_responses', 'google-genai'],
    resolveAdapterIdentity: (protocol: Protocol, providerType?: string) => ({
      baseId: protocol,
      traits:
        providerType === 'kimi' && protocol === 'openai'
          ? [
              {
                trait: { withThinking: () => undefined, strictThinkingValidation: true },
                context: {},
              },
            ]
          : providerType === 'kimi' && protocol === 'anthropic'
            ? [{ trait: { withThinking: () => undefined }, context: {} }]
            : [],
    }),
    resolveProviderBaseId: (protocol: Protocol) => protocol,
    resolveCapability: () => {
      throw new Error('not exercised');
    },
    createChatProvider: () => {
      throw new Error('not exercised');
    },
  } as unknown as IProtocolAdapterRegistry;
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
let modelCatalog: IModelCatalog;

function buildHost(key: string): {
  ix: TestInstantiationService;
  wire: IWireService;
  svc: IAgentProfileService;
  log: IAppendLogStore;
} {
  const host = disposables.add(new TestInstantiationService());
  host.stub(IFileSystemStorageService, new InMemoryStorageService());
  host.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  host.stub(ITelemetryService, createTelemetryStub());
  host.stub(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
  host.stub(
    IAgentTelemetryContextService,
    new AgentTelemetryContextService(),
  );
  host.stub(IConfigService, createConfigStub());
  host.stub(IModelCatalog, modelCatalog);
  host.stub(IProtocolAdapterRegistry, createProtocolRegistryStub());
  host.stub(IHostEnvironment, stubUnused());
  host.stub(IHostFileSystem, stubUnused());
  host.stub(IBootstrapService, stubUnused());
  host.stub(ISessionContext, createSessionContextStub());
  host.stub(ISessionWorkspaceContext, stubUnused());
  host.stub(ISessionAgentProfileCatalog, stubUnused());
  host.stub(ISessionSkillCatalog, stubUnused());
  host.stub(ISessionToolPolicy, {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    disabledTools: () => [],
    setDisabledTools: () => Promise.resolve(),
  });
  host.set(IAgentProfileService, new SyncDescriptor(AgentProfileService));
  const wire = registerTestAgentWire(host, testWireScope(SCOPE, key), {
    log: host.get(IAppendLogStore),
  });
  return {
    ix: host,
    wire,
    svc: host.get(IAgentProfileService),
    log: host.get(IAppendLogStore),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  configValues = {};
  modelCatalog = createModelCatalogStub();
  const host = buildHost(KEY);
  ix = host.ix;
  wire = host.wire;
  svc = host.svc;
  log = host.log;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<WireRecord[]> {
  await wire.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

function modelOf(target: IWireService) {
  return target.getModel(ProfileModel);
}

function activeToolsOf(target: IWireService) {
  return target.getModel(ActiveToolsModel);
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

  it('persists and replays an allowlist reset to unrestricted', async () => {
    svc.applyBindingSnapshot({
      cwd: '/work',
      profileName: 'restricted',
      thinkingLevel: 'off',
      systemPrompt: 'restricted',
      activeToolNames: ['Read'],
    });
    svc.applyBindingSnapshot({
      cwd: '/work',
      profileName: 'unrestricted',
      thinkingLevel: 'off',
      systemPrompt: 'unrestricted',
      activeToolNames: undefined,
    });
    expect(activeToolsOf(wire)).toBeUndefined();

    const replay = buildHost('profile-replay-active-tools');
    await restoreTestAgentWire(
      replay.wire,
      log,
      testWireScope(SCOPE, KEY),
      await readRecords(),
    );
    expect(activeToolsOf(replay.wire)).toBeUndefined();
    replay.ix.dispose();
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

    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'profile-replay'),
      records,
    );
    expect(modelOf(host.wire).cwd).toBe('/work');
    expect(modelOf(host.wire).profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(replayChdir).toBe(0);
    expect(replayEmits).toBe(0);

    const written: WireRecord[] = [];
    for await (const record of host.log.read<WireRecord>(
      testWireScope(SCOPE, 'profile-replay'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      written.push(record);
    }
    expect(written[0]).toMatchObject({ type: 'metadata' });
    expect(written.slice(1)).toEqual(records);
  });

  it('replay rebuilds the resolved thinkingLevel without re-reading config', async () => {
    svc.update({ thinkingLevel: 'on' });
    const records = await readRecords();

    const host = buildHost('profile-replay-thinking');
    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'profile-replay-thinking'),
      records,
    );
    expect(modelOf(host.wire).thinkingLevel).toBe('on');
  });

  it('replays legacy config.update thinkingLevel records', async () => {
    const host = buildHost('profile-replay-legacy-thinking-level');

    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'profile-replay-legacy-thinking-level'),
      [{ type: 'config.update', thinkingLevel: 'high' }],
    );

    expect(modelOf(host.wire).thinkingLevel).toBe('high');
  });

  it('returns the persisted effort when a replayed model alias no longer resolves', async () => {
    const host = buildHost('profile-replay-removed-model');

    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'profile-replay-removed-model'),
      [{
        type: 'config.update',
        modelAlias: 'removed-model',
        thinkingEffort: 'high',
      }],
    );

    expect(host.svc.getEffectiveThinkingLevel()).toBe('high');
  });

  it('rejects conflicting config.update thinking aliases during replay', async () => {
    const host = buildHost('profile-replay-conflicting-thinking-aliases');

    await expect(
      restoreTestAgentWire(
        host.wire,
        host.log,
        testWireScope(SCOPE, 'profile-replay-conflicting-thinking-aliases'),
        [{ type: 'config.update', thinkingEffort: 'low', thinkingLevel: 'high' }],
      ),
    ).rejects.toMatchObject({
      code: 'profile.thinking_alias_conflict',
      name: 'ProfileError',
    });
  });

  it('applies thinking.keep model override when thinking is enabled', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ providerType: 'kimi' }),
    });
    const host = buildHost('profile-thinking-keep');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['modelOverrides'] = { temperature: 0.3, thinkingKeep: 'all' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    // The morph chain's replacement: the profile's dialect-free per-turn
    // intent. Wire encoding (`extra_body.thinking.keep`) is the Kimi dialect's
    // own hook now.
    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      sampling: { temperature: 0.3 },
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('uses the resolved Kimi effort instead of the configured default', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ providerType: 'kimi' }),
    });
    const host = buildHost('profile-thinking-effort-resolved');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['thinking'] = { effort: ' max ' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('forces the environment Kimi effort instead of the resolved effort', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ providerType: 'kimi' }),
    });
    const host = buildHost('profile-thinking-effort-force');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['thinking'] = { effort: 'low', forcedEffort: ' max ' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    expect(host.svc.data().thinkingLevel).toBe('high');
    expect(modelOf(host.wire).thinkingLevel).toBe('high');
    expect(host.svc.resolveModelContext().thinkingLevel).toBe('max');

    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      thinkingEffort: 'max',
      thinkingKeep: 'all',
    });
  });

  it('does not leak a forced Kimi effort when switching to a non-Kimi model', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ providerType: 'kimi' }),
      'other-code': createTestModel({ id: 'other-code', protocol: 'anthropic' }),
    });
    const host = buildHost('profile-thinking-effort-force-switch');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['thinking'] = { forcedEffort: 'max' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    expect(host.svc.data().thinkingLevel).toBe('high');
    expect(host.svc.resolveModelContext().thinkingLevel).toBe('max');
    expect(host.svc.resolveRequestParams().thinkingEffort).toBe('max');

    host.svc.update({ modelAlias: 'other-code' });
    expect(host.svc.data().thinkingLevel).toBe('high');
    expect(host.svc.resolveModelContext().thinkingLevel).toBe('high');
    expect(host.svc.resolveRequestParams().thinkingEffort).toBe('high');
  });

  it('applies thinking.keep model override on the Anthropic path', () => {
    modelCatalog = createModelCatalogStub({
      'claude-code': createTestModel({ id: 'claude-code', protocol: 'anthropic' }),
    });
    const host = buildHost('profile-thinking-keep-anthropic');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['modelOverrides'] = { temperature: 0.3, thinkingKeep: 'all' };

    host.svc.update({ modelAlias: 'claude-code', thinkingLevel: 'high' });

    // The intent is dialect-free now; how a cache key reaches the Anthropic
    // wire (`metadata.user_id`) is the dialect's own hook.
    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      sampling: { temperature: 0.3 },
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('forces Kimi effort through Anthropic without Kimi generation kwargs', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ protocol: 'anthropic', providerType: 'kimi' }),
    });
    const host = buildHost('profile-thinking-effort-force-anthropic');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['thinking'] = { forcedEffort: 'max' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    // "Without Kimi generation kwargs" is no longer decidable at the profile:
    // the durable record in `llmRequester.recordRequest` carries the
    // thinking/sampling knobs unconditionally, and the Anthropic dialect
    // encodes the thinking intent itself.
    expect(host.svc.resolveModelContext().thinkingLevel).toBe('max');
    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      thinkingEffort: 'max',
      thinkingKeep: 'all',
    });
  });

  it('defaults thinking.keep to "all" when thinking is enabled on Kimi', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ providerType: 'kimi' }),
    });
    const host = buildHost('profile-thinking-keep-default');
    host.svc.configure({ emitStatusUpdated: () => undefined });

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('treats an off env thinking.keep override as disabled on Kimi', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ providerType: 'kimi' }),
    });
    const host = buildHost('profile-thinking-keep-env-off');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['modelOverrides'] = { thinkingKeep: 'off' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    const params = host.svc.resolveRequestParams();
    expect(params.cacheKey).toBe('session-test');
    expect(params.thinkingEffort).toBe('high');
    expect(params.thinkingKeep).toBeUndefined();
  });

  it('applies config thinking.keep on the Anthropic path', () => {
    modelCatalog = createModelCatalogStub({
      'claude-code': createTestModel({ id: 'claude-code', protocol: 'anthropic' }),
    });
    const host = buildHost('profile-thinking-keep-anthropic-config');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['thinking'] = { keep: 'config-keep' };

    host.svc.update({ modelAlias: 'claude-code', thinkingLevel: 'high' });

    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      thinkingEffort: 'high',
      thinkingKeep: 'config-keep',
    });
  });

  it('does not apply thinking.keep model override when thinking is off', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ providerType: 'kimi' }),
    });
    const host = buildHost('profile-thinking-keep-off');
    host.svc.configure({ emitStatusUpdated: () => undefined });
    configValues['thinking'] = { forcedEffort: 'max' };
    configValues['modelOverrides'] = { temperature: 0.3, thinkingKeep: 'all' };

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'off' });
    expect(host.svc.resolveModelContext().thinkingLevel).toBe('off');

    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      sampling: { temperature: 0.3 },
      thinkingEffort: 'off',
      thinkingKeep: undefined,
    });
  });

  it('uses the session id as a Kimi prompt cache hint', () => {
    modelCatalog = createModelCatalogStub({
      'kimi-code': createTestModel({ providerType: 'kimi' }),
    });
    const host = buildHost('profile-prompt-cache-key');
    host.svc.configure({ emitStatusUpdated: () => undefined });

    host.svc.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(host.svc.resolveRequestParams()).toEqual({
      cacheKey: 'session-test',
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('resolves the session cache-key intent for non-Kimi protocols too', () => {
    modelCatalog = createModelCatalogStub({
      'claude-sonnet': createTestModel({ id: 'claude-sonnet', protocol: 'anthropic' }),
    });
    const host = buildHost('profile-prompt-cache-key-anthropic');
    host.svc.configure({ emitStatusUpdated: () => undefined });

    host.svc.update({ modelAlias: 'claude-sonnet', thinkingLevel: 'high' });

    // The cache-key intent is dialect-free now: the profile resolves it for
    // every protocol. How each dialect encodes it (Kimi `prompt_cache_key`
    // vs Anthropic `metadata.user_id` vs silently dropped) is the dialect
    // hook's own decision, asserted at the kosong/provider composition layer.
    expect(host.svc.resolveRequestParams().cacheKey).toBe('session-test');
  });
});
