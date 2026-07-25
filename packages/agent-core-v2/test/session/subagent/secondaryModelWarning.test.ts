import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope, type IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { SECONDARY_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { ErrorCodes, Error2 } from '#/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionSecondaryModelWarningService,
  SECONDARY_MODEL_EFFORT_WARNING_CODE,
  SECONDARY_MODEL_INVALID_WARNING_CODE,
} from '#/session/subagent/secondaryModelWarning';
import { SessionSecondaryModelWarningService } from '#/session/subagent/secondaryModelWarningService';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';

import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

describe('SessionSecondaryModelWarningService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let onDidCreate: Emitter<IAgentScopeHandle>;
  let handles: Map<string, IAgentScopeHandle>;
  let published: DomainEvent[];
  let modelIds: Record<string, Model>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    onDidCreate = disposables.add(new Emitter<IAgentScopeHandle>());
    handles = new Map();
    published = [];
    modelIds = {};
  });
  afterEach(() => {
    disposables.dispose();
  });

  function setup(configValues: Record<string, unknown>, flagEnabled = true): void {
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreate: onDidCreate.event,
      get: (agentId: string) => handles.get(agentId),
    } as unknown as IAgentLifecycleService);
    ix.stub(IConfigService, new StubConfigService(configValues));
    ix.stub(
      IFlagService,
      stubFlag((id) => flagEnabled && id === SECONDARY_MODEL_FLAG_ID),
    );
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: (id: string) => {
        const model = modelIds[id];
        if (model === undefined) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, `Model "${id}" is not configured in config.toml.`, {
            details: { model: id },
          });
        }
        return model;
      },
    } as unknown as IModelCatalog);
    ix.set(
      ISessionSecondaryModelWarningService,
      new SyncDescriptor(SessionSecondaryModelWarningService),
    );
  }

  function createMain(): IAgentScopeHandle {
    const handle = agentHandle(MAIN_AGENT_ID, published);
    handles.set(MAIN_AGENT_ID, handle);
    onDidCreate.fire(handle);
    return handle;
  }

  it('stays silent when no secondary model is configured', () => {
    setup({});
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('stays silent when the secondary-model experiment is disabled', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/typo' } }, false);
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('warns when the configured secondary model does not resolve', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/typo' } });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    const warning = svc.getSecondaryModelWarning();
    expect(warning?.code).toBe(SECONDARY_MODEL_INVALID_WARNING_CODE);
    expect(warning?.message).toContain('"provider/typo"');
    expect(warning?.message).toContain('KIMI_SECONDARY_MODEL');
    expect(warning?.message).toContain('not configured');
    expect(published).toEqual([
      { type: 'warning', code: warning?.code, message: warning?.message },
    ]);
  });

  it('warns when the configured default effort is not listed by the resolved model', () => {
    modelIds['provider/secondary'] = modelStub({ supportEfforts: ['low', 'high'] });
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/secondary', defaultEffort: 'hihg' } });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    const warning = svc.getSecondaryModelWarning();
    expect(warning?.code).toBe(SECONDARY_MODEL_EFFORT_WARNING_CODE);
    expect(warning?.message).toContain('"hihg"');
    expect(warning?.message).toContain('low, high');
    expect(warning?.message).toContain('KIMI_SECONDARY_EFFORT');
  });

  it.each([
    { secondary: { model: 'provider/secondary', defaultEffort: 'high' }, label: 'a listed effort' },
    { secondary: { model: 'provider/secondary', defaultEffort: 'off' }, label: '"off"' },
    { secondary: { model: 'provider/secondary', defaultEffort: 'on' }, label: '"on"' },
    { secondary: { model: 'provider/secondary' }, label: 'no effort' },
  ])('stays silent for $label', ({ secondary }) => {
    modelIds['provider/secondary'] = modelStub({ supportEfforts: ['low', 'high'] });
    setup({ [SECONDARY_MODEL_SECTION]: secondary });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('checks the effort against the patched supportEfforts of the derived entry', () => {
    modelIds['provider/secondary'] = modelStub({ supportEfforts: ['low', 'high'] });
    setup({
      [SECONDARY_MODEL_SECTION]: {
        model: 'provider/secondary',
        supportEfforts: ['low'],
        defaultEffort: 'high',
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    const warning = svc.getSecondaryModelWarning();
    expect(warning?.code).toBe(SECONDARY_MODEL_EFFORT_WARNING_CODE);
    expect(warning?.message).toContain('"high"');
    expect(warning?.message).toContain('known: low');
  });

  it('stays silent when the patched supportEfforts lists the default effort', () => {
    modelIds['provider/secondary'] = modelStub({ supportEfforts: ['high'] });
    setup({
      [SECONDARY_MODEL_SECTION]: {
        model: 'provider/secondary',
        supportEfforts: ['low'],
        defaultEffort: 'low',
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('stays silent for any effort when the model lists none', () => {
    modelIds['provider/freeform'] = modelStub({});
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/freeform', defaultEffort: 'whatever' } });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('ignores created agents that are not the main agent', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/typo' } });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    onDidCreate.fire(agentHandle('agent-1', published));
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('checks a main agent that already exists at construction', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/typo' } });
    handles.set(MAIN_AGENT_ID, agentHandle(MAIN_AGENT_ID, published));
    const svc = ix.get(ISessionSecondaryModelWarningService);
    expect(svc.getSecondaryModelWarning()?.code).toBe(SECONDARY_MODEL_INVALID_WARNING_CODE);
    expect(published).toHaveLength(1);
  });

  it('publishes at most once when both trigger paths fire', () => {
    setup({ [SECONDARY_MODEL_SECTION]: { model: 'provider/typo' } });
    handles.set(MAIN_AGENT_ID, agentHandle(MAIN_AGENT_ID, published));
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()?.code).toBe(SECONDARY_MODEL_INVALID_WARNING_CODE);
    expect(published).toHaveLength(1);
  });
});

function agentHandle(id: string, published: DomainEvent[]): IAgentScopeHandle {
  const bus: IEventBus = {
    _serviceBrand: undefined,
    publish: vi.fn((event: DomainEvent) => {
      published.push(event);
    }),
    subscribe: vi.fn(() => ({ dispose: () => {} })) as IEventBus['subscribe'],
  };
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) => {
        if (serviceId === IEventBus) return bus;
        throw new Error('unexpected service resolution');
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

function modelStub(overrides: Partial<Model>): Model {
  return {
    id: 'provider/secondary',
    name: 'secondary',
    aliases: [],
    protocol: 'openai',
    headers: {},
    capabilities: {},
    maxContextSize: 100000,
    alwaysThinking: false,
    providerName: 'provider',
    authProvider: { getAuth: () => Promise.resolve({}) },
    ...overrides,
  } as unknown as Model;
}
