/**
 * Scenario: session startup validation for legacy and named subagent models.
 *
 * Resolves the warning service through its interface with real model-selection
 * logic while stubbing lifecycle events, config, flags, the model catalog, and
 * the event bus. Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest
 * run test/session/subagent/secondaryModelWarning.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope, type IAgentScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import {
  MODELS_SECTION,
  SECONDARY_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import { SUBAGENT_MODELS_SECTION } from '#/session/subagent/configSection';
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

  function setup(
    configValues: Record<string, unknown>,
    flagEnabled = true,
    config = new StubConfigService(configValues),
  ): void {
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreate: onDidCreate.event,
      get: (agentId: string) => handles.get(agentId),
    } as unknown as IAgentLifecycleService);
    ix.stub(IConfigService, config);
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

  it('warns when the persisted named-slot section fails schema validation', () => {
    const config = new StubConfigService();
    vi.spyOn(config, 'inspect').mockImplementation((domain) =>
      domain === SUBAGENT_MODELS_SECTION
        ? {
            value: undefined,
            defaultValue: undefined,
            userValue: {
              fast: {
                model: 'provider/fast',
              },
            },
            memoryValue: undefined,
          }
        : {
            value: undefined,
            defaultValue: undefined,
            userValue: undefined,
            memoryValue: undefined,
          },
    );
    vi.spyOn(config, 'diagnostics').mockReturnValue([
      {
        domain: SUBAGENT_MODELS_SECTION,
        severity: 'warning',
        message: "Ignored invalid config section 'subagentModels': description is required",
      },
    ]);
    setup({}, true, config);

    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();

    expect(svc.getSecondaryModelWarning()).toMatchObject({
      code: SECONDARY_MODEL_INVALID_WARNING_CODE,
      message: expect.stringContaining(
        "Ignored invalid config section 'subagentModels'",
      ),
    });
    expect(published).toHaveLength(1);
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

  // -- named-slot (subagent_models) tests --

  it('warns when a named slot points at a non-existent model', () => {
    setup({
      [SUBAGENT_MODELS_SECTION]: {
        myslot: { model: 'provider/typo', description: 'My custom slot' },
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    const warning = svc.getSecondaryModelWarning();
    expect(warning?.code).toBe(SECONDARY_MODEL_INVALID_WARNING_CODE);
    expect(warning?.message).toContain('"myslot"');
    expect(warning?.message).toContain('"provider/typo"');
    expect(warning?.message).toContain('[subagent_models.myslot].model');
    expect(warning?.message).not.toContain('[secondary_model]');
    expect(published).toEqual([
      { type: 'warning', code: warning?.code, message: warning?.message },
    ]);
  });

  it('attributes a named secondary slot warning to subagent_models', () => {
    setup({
      [SUBAGENT_MODELS_SECTION]: {
        secondary: {
          model: 'provider/typo',
          description: 'Named secondary slot',
        },
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();

    expect(svc.getSecondaryModelWarning()).toEqual({
      code: SECONDARY_MODEL_INVALID_WARNING_CODE,
      message:
        'Subagent model slot "secondary" points at "provider/typo" ' +
        '(from [subagent_models.secondary].model) which could not be resolved: ' +
        'Model "provider/typo" is not configured in config.toml. ' +
        'Subagent spawning will fail until this is fixed.',
    });
  });

  it('warns when a named slot collides with a user-owned model id', () => {
    setup({
      [MODELS_SECTION]: {
        base: { provider: 'example', model: 'fast' },
        __sm__fast: { provider: 'example', model: 'user-fast' },
      },
      [SUBAGENT_MODELS_SECTION]: {
        fast: {
          model: 'base',
          description: 'Fast',
          maxOutputSize: 4096,
        },
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();

    const warning = svc.getSecondaryModelWarning();
    expect(warning).toEqual({
      code: SECONDARY_MODEL_INVALID_WARNING_CODE,
      message:
        'Subagent model configuration could not be resolved: ' +
        '[subagent_models.fast] would overwrite user-defined model "__sm__fast" — ' +
        'rename or remove the [models.__sm__fast] entry.',
    });
    expect(published).toEqual([
      {
        type: 'warning',
        code: SECONDARY_MODEL_INVALID_WARNING_CODE,
        message: warning?.message,
      },
    ]);
  });

  it('warns when a named slot has an unsupported default effort', () => {
    modelIds['provider/secondary'] = modelStub({ supportEfforts: ['low', 'high'] });
    setup({
      [SUBAGENT_MODELS_SECTION]: {
        myslot: {
          model: 'provider/secondary',
          description: 'My custom slot',
          defaultEffort: 'hihg',
        },
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    const warning = svc.getSecondaryModelWarning();
    expect(warning?.code).toBe(SECONDARY_MODEL_EFFORT_WARNING_CODE);
    expect(warning?.message).toContain('"hihg"');
    expect(warning?.message).toContain('low, high');
    expect(warning?.message).toContain('[subagent_models.myslot].default_effort');
  });

  it('warns when patched supportEfforts exclude the named slot default effort', () => {
    modelIds['provider/secondary'] = modelStub({ supportEfforts: ['low', 'high'] });
    setup({
      [SUBAGENT_MODELS_SECTION]: {
        myslot: {
          model: 'provider/secondary',
          description: 'My custom slot',
          supportEfforts: ['low'],
          defaultEffort: 'high',
        },
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    const warning = svc.getSecondaryModelWarning();
    expect(warning?.code).toBe(SECONDARY_MODEL_EFFORT_WARNING_CODE);
    expect(warning?.message).toContain('"high"');
    expect(warning?.message).toContain('known: low');
  });

  it('warns on the first invalid slot when multiple slots are configured', () => {
    modelIds['provider/valid'] = modelStub({});
    setup({
      [SUBAGENT_MODELS_SECTION]: {
        valid: { model: 'provider/valid', description: 'Valid' },
        bad: { model: 'provider/typo', description: 'Bad' },
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    const warning = svc.getSecondaryModelWarning();
    expect(warning?.code).toBe(SECONDARY_MODEL_INVALID_WARNING_CODE);
    expect(warning?.message).toContain('"bad"');
    expect(warning?.message).toContain('"provider/typo"');
    expect(warning?.message).toContain('[subagent_models.bad].model');
  });

  it('stays silent for named slots when the flag is disabled', () => {
    setup(
      {
        [SUBAGENT_MODELS_SECTION]: {
          myslot: { model: 'provider/typo', description: 'My custom slot' },
        },
      },
      false,
    );
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('stays silent when a named slot has a valid config with no effort', () => {
    modelIds['provider/secondary'] = modelStub({ supportEfforts: ['low', 'high'] });
    setup({
      [SUBAGENT_MODELS_SECTION]: {
        myslot: { model: 'provider/secondary', description: 'My custom slot' },
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('stays silent when a named slot has a valid config with a listed default effort', () => {
    modelIds['provider/secondary'] = modelStub({ supportEfforts: ['low', 'high'] });
    setup({
      [SUBAGENT_MODELS_SECTION]: {
        myslot: {
          model: 'provider/secondary',
          description: 'My custom slot',
          defaultEffort: 'low',
        },
      },
    });
    const svc = ix.get(ISessionSecondaryModelWarningService);
    createMain();
    expect(svc.getSecondaryModelWarning()).toBeUndefined();
    expect(published).toHaveLength(0);
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
