import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentProfileService, ProfileError } from '#/agent/profile/profile';
import { AgentProfileService } from '#/agent/profile/profileService';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IProtocolAdapterRegistry, type Protocol } from '#/kosong/protocol/protocol';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';

import '#/kosong/provider/providers/kimi/kimi.contrib';

import { registerTestAgentWire, registerTestEventDispatcher, testWireScope } from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'profile-compact-threshold-test';
const MOCK_MODEL = 'kimi-code';

function createTelemetryStub(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: () => undefined,
    track2: () => undefined,
    setContext: () => {},
  } as unknown as ITelemetryService;
}

function createConfigStub(): IConfigService {
  return {
    _serviceBrand: undefined,
    onDidSectionChange: () => ({ dispose: () => {} }),
    get: ((key: string) => configValues[key]) as unknown as IConfigService['get'],
  } as unknown as IConfigService;
}

function createTestModel(): Model {
  return {
    id: MOCK_MODEL,
    name: 'kimi-for-coding',
    aliases: [],
    protocol: 'openai',
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
    alwaysThinking: false,
    providerType: 'kimi',
    providerName: 'kimi',
    authProvider: { getAuth: async () => undefined },
  };
}

function createModelCatalogStub(model: Model): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (id) => {
      if (id !== model.id) throw new Error(`Unknown model: ${String(id)}`);
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
let svc: IAgentProfileService;
let configValues: Record<string, unknown>;

function buildHost(key: string): IAgentProfileService {
  const host = disposables.add(new TestInstantiationService());
  host.stub(IFileSystemStorageService, new InMemoryStorageService());
  host.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  host.stub(ITelemetryService, createTelemetryStub());
  host.stub(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
  host.stub(IConfigService, createConfigStub());
  host.stub(IModelCatalog, createModelCatalogStub(createTestModel()));
  host.stub(IProtocolAdapterRegistry, createProtocolRegistryStub());
  host.stub(IHostEnvironment, stubUnused());
  host.stub(IHostFileSystem, stubUnused());
  host.stub(IBootstrapService, stubUnused());
  host.stub(ISessionContext, createSessionContextStub());
  host.stub(ISessionWorkspaceContext, stubUnused());
  host.stub(ISessionAgentProfileCatalog, {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: () => undefined,
    getDefault: () => {
      throw new Error('catalog resolution is not exercised');
    },
    list: () => [],
    load: async () => {},
    reload: async () => {},
    onDidChange: () => ({ dispose: () => {} }),
  });
  host.stub(ISessionSkillCatalog, {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
  });
  host.stub(ISessionInstructionsProvider, {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    agentsMd: undefined,
    agentsMdWarning: undefined,
    agentsMdPaths: undefined,
    onDidChange: Event.None as Event<never>,
  } satisfies ISessionInstructionsProvider);
  host.stub(IAgentAgentsMdReminderService, {
    _serviceBrand: undefined,
    seedInjected: () => {},
  });
  host.stub(ISessionToolPolicy, {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    disabledTools: () => [],
    setDisabledTools: () => Promise.resolve(),
  });
  host.set(IAgentStateService, new AgentStateService());
  host.set(IAgentProfileService, new SyncDescriptor(AgentProfileService));
  registerTestAgentWire(host, testWireScope(SCOPE, key), {
    log: host.get(IAppendLogStore),
  });
  registerTestEventDispatcher(host);
  return host.get(IAgentProfileService);
}

beforeEach(() => {
  disposables = new DisposableStore();
  configValues = {};
  svc = buildHost(KEY);
});

afterEach(() => disposables.dispose());

describe('AgentProfileService.setCompactionTriggerRatio', () => {
  it('rejects values below 0.05 (the widened minimum)', () => {
    expect(() => svc.setCompactionTriggerRatio(0.04)).toThrow(ProfileError);
    expect(() => svc.setCompactionTriggerRatio(0.0499)).toThrow(ProfileError);
  });

  it('rejects values above 0.99 and non-finite values', () => {
    expect(() => svc.setCompactionTriggerRatio(1)).toThrow(ProfileError);
    expect(() => svc.setCompactionTriggerRatio(Number.NaN)).toThrow(ProfileError);
    expect(() => svc.setCompactionTriggerRatio(Number.POSITIVE_INFINITY)).toThrow(ProfileError);
  });

  it('accepts the boundary values 0.05 and 0.99', () => {
    svc.setCompactionTriggerRatio(0.05);
    expect(svc.getCompactionTriggerRatioOverride()).toBe(0.05);
    svc.setCompactionTriggerRatio(0.99);
    expect(svc.getCompactionTriggerRatioOverride()).toBe(0.99);
  });

  it('clears the override when called with undefined', () => {
    svc.setCompactionTriggerRatio(0.3);
    expect(svc.getCompactionTriggerRatioOverride()).toBe(0.3);
    svc.setCompactionTriggerRatio(undefined);
    expect(svc.getCompactionTriggerRatioOverride()).toBeUndefined();
  });

  it('getEffectiveCompactionTriggerRatio resolves precedence without a bound model', () => {
    configValues['loopControl'] = { compactionTriggerRatio: 0.7 };
    expect(svc.getEffectiveCompactionTriggerRatio()).toBe(0.7);
    svc.setCompactionTriggerRatio(0.3);
    expect(svc.getEffectiveCompactionTriggerRatio()).toBe(0.3);
    svc.setCompactionTriggerRatio(undefined);
    expect(svc.getEffectiveCompactionTriggerRatio()).toBe(0.7);
  });
});

describe('AgentProfileService compaction trigger ratio precedence', () => {
  beforeEach(() => {
    svc.update({ modelAlias: MOCK_MODEL });
  });

  it('uses the config value when no override is set', () => {
    configValues['loopControl'] = { compactionTriggerRatio: 0.7 };
    expect(svc.resolveModelContext().compactionTriggerRatio).toBe(0.7);
  });

  it('the session override takes precedence over the config value', () => {
    configValues['loopControl'] = { compactionTriggerRatio: 0.7 };
    svc.setCompactionTriggerRatio(0.3);
    expect(svc.resolveModelContext().compactionTriggerRatio).toBe(0.3);
  });

  it('returns undefined when neither override nor config sets a value', () => {
    expect(svc.resolveModelContext().compactionTriggerRatio).toBeUndefined();
  });

  it('falls back to the config value after the override is cleared', () => {
    configValues['loopControl'] = { compactionTriggerRatio: 0.7 };
    svc.setCompactionTriggerRatio(0.3);
    svc.setCompactionTriggerRatio(undefined);
    expect(svc.resolveModelContext().compactionTriggerRatio).toBe(0.7);
    expect(svc.getCompactionTriggerRatioOverride()).toBeUndefined();
  });

  it('respects a config value at the new 0.05 minimum', () => {
    configValues['loopControl'] = { compactionTriggerRatio: 0.05 };
    expect(svc.resolveModelContext().compactionTriggerRatio).toBe(0.05);
  });
});
describe('AgentProfileService.setCompactionTokenBudget', () => {
  it('stores the override as tokens (input N means N * 1000)', () => {
    svc.setCompactionTokenBudget(120);
    expect(svc.getCompactionTokenBudgetOverride()).toBe(120_000);
  });

  it('clears the override when called with undefined', () => {
    svc.setCompactionTokenBudget(120);
    expect(svc.getCompactionTokenBudgetOverride()).toBe(120_000);
    svc.setCompactionTokenBudget(undefined);
    expect(svc.getCompactionTokenBudgetOverride()).toBeUndefined();
  });

  it('rejects 0 (below the 1 000-token floor)', () => {
    expect(() => svc.setCompactionTokenBudget(0)).toThrow(ProfileError);
    expect(svc.getCompactionTokenBudgetOverride()).toBeUndefined();
  });

  it('rejects negative values', () => {
    expect(() => svc.setCompactionTokenBudget(-1)).toThrow(ProfileError);
    expect(svc.getCompactionTokenBudgetOverride()).toBeUndefined();
  });

  it('rejects NaN', () => {
    expect(() => svc.setCompactionTokenBudget(Number.NaN)).toThrow(ProfileError);
    expect(svc.getCompactionTokenBudgetOverride()).toBeUndefined();
  });

  it('rejects non-integer values', () => {
    expect(() => svc.setCompactionTokenBudget(2.5)).toThrow(ProfileError);
    expect(svc.getCompactionTokenBudgetOverride()).toBeUndefined();
  });

  it('getEffectiveCompactionTokenBudget resolves precedence: override > config > default', () => {
    configValues['loopControl'] = { compactionTokenBudget: 200_000 };
    expect(svc.getEffectiveCompactionTokenBudget()).toBe(200_000);
    svc.setCompactionTokenBudget(120);
    expect(svc.getEffectiveCompactionTokenBudget()).toBe(120_000);
    svc.setCompactionTokenBudget(undefined);
    expect(svc.getEffectiveCompactionTokenBudget()).toBe(200_000);
  });

  it('token override and ratio override are independent', () => {
    svc.setCompactionTriggerRatio(0.5);
    svc.setCompactionTokenBudget(120);
    expect(svc.getCompactionTriggerRatioOverride()).toBe(0.5);
    expect(svc.getCompactionTokenBudgetOverride()).toBe(120_000);
    svc.setCompactionTokenBudget(undefined);
    expect(svc.getCompactionTriggerRatioOverride()).toBe(0.5);
  });
});

describe('AgentProfileService.setCompactionTokenBudget telemetry (U11)', () => {
  let track2Calls: Array<[string, Record<string, unknown>]>;

  function buildHostWithTelemetrySpy(key: string): IAgentProfileService {
    const host = disposables.add(new TestInstantiationService());
    host.stub(IFileSystemStorageService, new InMemoryStorageService());
    host.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    track2Calls = [];
    host.stub(ITelemetryService, {
      _serviceBrand: undefined,
      track: () => undefined,
      track2: (event: string, payload: Record<string, unknown>) => {
        track2Calls.push([event, payload]);
      },
      setContext: () => {},
    } as unknown as ITelemetryService);
    host.stub(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
    host.stub(IConfigService, createConfigStub());
    host.stub(IModelCatalog, createModelCatalogStub(createTestModel()));
    host.stub(IProtocolAdapterRegistry, createProtocolRegistryStub());
    host.stub(IHostEnvironment, stubUnused());
    host.stub(IHostFileSystem, stubUnused());
    host.stub(IBootstrapService, stubUnused());
    host.stub(ISessionContext, createSessionContextStub());
    host.stub(ISessionWorkspaceContext, stubUnused());
    host.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => {
        throw new Error('catalog resolution is not exercised');
      },
      list: () => [],
      load: async () => {},
      reload: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    });
    host.stub(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
    });
    host.stub(ISessionInstructionsProvider, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      agentsMd: undefined,
      agentsMdWarning: undefined,
      agentsMdPaths: undefined,
      onDidChange: Event.None as Event<never>,
    } satisfies ISessionInstructionsProvider);
    host.stub(IAgentAgentsMdReminderService, {
      _serviceBrand: undefined,
      seedInjected: () => {},
    });
    host.stub(ISessionToolPolicy, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      disabledTools: () => [],
      setDisabledTools: () => Promise.resolve(),
    });
    host.set(IAgentStateService, new AgentStateService());
    host.set(IAgentProfileService, new SyncDescriptor(AgentProfileService));
    registerTestAgentWire(host, testWireScope(SCOPE, key), {
      log: host.get(IAppendLogStore),
    });
    registerTestEventDispatcher(host);
    return host.get(IAgentProfileService);
  }

  it('fires compaction_token_budget_override with action: set on store', () => {
    const spySvc = buildHostWithTelemetrySpy(KEY);
    spySvc.setCompactionTokenBudget(120);
    const matching = track2Calls.filter(([event]) => event === 'compaction_token_budget_override');
    expect(matching.length).toBeGreaterThan(0);
    const last = matching[matching.length - 1] as [string, Record<string, unknown>];
    const [event, payload] = last;
    expect(event).toBe('compaction_token_budget_override');
    expect(payload['action']).toBe('set');
    expect(payload['tokens']).toBe(120_000);
  });

  it('fires compaction_token_budget_override with action: clear on undefined', () => {
    const spySvc = buildHostWithTelemetrySpy(KEY);
    spySvc.setCompactionTokenBudget(120);
    spySvc.setCompactionTokenBudget(undefined);
    const matching = track2Calls.filter(([event]) => event === 'compaction_token_budget_override');
    expect(matching.length).toBeGreaterThanOrEqual(2);
    const last = matching[matching.length - 1] as [string, Record<string, unknown>];
    const [event, payload] = last;
    expect(event).toBe('compaction_token_budget_override');
    expect(payload['action']).toBe('clear');
  });

  it('does not fire compaction_token_budget_override on validation reject', () => {
    const spySvc = buildHostWithTelemetrySpy(KEY);
    expect(() => spySvc.setCompactionTokenBudget(0)).toThrow(ProfileError);
    const matching = track2Calls.filter(([event]) => event === 'compaction_token_budget_override');
    expect(matching.length).toBe(0);
  });
});

describe('AgentProfileService session model overrides', () => {
  const overrideKinds = [
    'visual',
    'compaction',
    'compactionSecondary',
    'fallback',
    'fallbackSecondary',
    'substitute',
    'secondary',
  ] as const;

  it('starts with no overrides', () => {
    expect(svc.getAllSessionModelOverrides()).toEqual({});
    for (const kind of overrideKinds) {
      expect(svc.getSessionModelOverride(kind)).toBeUndefined();
    }
  });

  it('stores and returns each override by kind', () => {
    for (const kind of overrideKinds) {
      svc.setSessionModelOverride(kind, `model-for-${kind}`);
      expect(svc.getSessionModelOverride(kind)).toBe(`model-for-${kind}`);
    }
    const all = svc.getAllSessionModelOverrides();
    for (const kind of overrideKinds) {
      expect(all[kind as keyof typeof all]).toBe(`model-for-${kind}`);
    }
  });

  it('clears an override when set to undefined', () => {
    svc.setSessionModelOverride('visual', 'visual-a');
    expect(svc.getSessionModelOverride('visual')).toBe('visual-a');
    svc.setSessionModelOverride('visual', undefined);
    expect(svc.getSessionModelOverride('visual')).toBeUndefined();
    expect(svc.getAllSessionModelOverrides()).toEqual({});
  });

  it('overrides of different kinds are independent', () => {
    svc.setSessionModelOverride('compaction', 'compact-a');
    svc.setSessionModelOverride('compactionSecondary', 'compact-secondary-a');
    expect(svc.getSessionModelOverride('compaction')).toBe('compact-a');
    expect(svc.getSessionModelOverride('compactionSecondary')).toBe('compact-secondary-a');
    svc.setSessionModelOverride('compaction', undefined);
    expect(svc.getSessionModelOverride('compaction')).toBeUndefined();
    expect(svc.getSessionModelOverride('compactionSecondary')).toBe('compact-secondary-a');
  });
});
