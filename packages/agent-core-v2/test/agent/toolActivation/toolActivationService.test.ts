import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  createAppScope,
  registerScopedService,
  type ScopeSeed,
} from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { Event } from '#/_base/event';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { AgentToolActivationService } from '#/agent/toolActivation/toolActivationService';
import {
  BuiltinToolAssemblyService,
  IBuiltinToolAssemblyService,
} from '#/agent/toolRegistry/builtinToolAssemblyService';
import {
  _clearAgentToolContributionsForTests,
  AgentToolContribution,
  getAgentToolContributions,
  registerAgentToolService,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import '#/agent/tools/agent-swarm/agentSwarmTool';
import '#/agent/tools/agent/agentTool';
import '#/agent/tools/ask-user-question/askUserQuestionTool';
import '#/agent/tools/edit/editTool';
import '#/agent/tools/fetch-url/fetchUrlTool';
import '#/agent/tools/goal/create-goal/createGoalTool';
import '#/agent/tools/goal/get-goal/getGoalTool';
import '#/agent/tools/goal/set-goal-budget/setGoalBudgetTool';
import '#/agent/tools/goal/update-goal/updateGoalTool';
import '#/agent/tools/os/bash/bashTool';
import '#/agent/tools/os/glob/globTool';
import '#/agent/tools/os/grep/grepTool';
import '#/agent/tools/os/read/readTool';
import '#/agent/tools/os/write/writeTool';
import '#/agent/tools/select-tools/selectToolsTool';
import '#/agent/tools/skill/skillTool';
import '#/agent/tools/task/task-list/taskListTool';
import '#/agent/tools/task/task-output/taskOutputTool';
import '#/agent/tools/task/task-stop/taskStopTool';
import '#/agent/tools/todo-list/todoListTool';
import '#/agent/tools/web-search/webSearchTool';

class StubTool implements AgentTool {
  declare readonly _serviceBrand: undefined;
  readonly description = 'stub';
  readonly parameters: Record<string, unknown> = {};
  constructor(readonly name: string) {}
  resolveExecution(): ToolExecution {
    return { isError: true, output: 'stub' };
  }
}

const IAlphaTool = createDecorator<AgentTool>('activationTestAlphaTool');
const IBetaTool = createDecorator<AgentTool>('activationTestBetaTool');
const IGammaTool = createDecorator<AgentTool>('activationTestGammaTool');

let alphaConstructions = 0;
let betaConstructions = 0;
let gammaConstructions = 0;

class AlphaTool extends StubTool {
  constructor() {
    super('Alpha');
    alphaConstructions += 1;
  }
}

class BetaTool extends StubTool {
  constructor() {
    super('Beta');
    betaConstructions += 1;
  }
}

class GammaTool extends StubTool {
  constructor() {
    super('Gamma');
    gammaConstructions += 1;
  }
}

class TestContributionAssembly extends Service {
  constructor() {
    super();
    for (const record of getAgentToolContributions()) {
      this.provide(AgentToolContribution, record);
    }
  }
}

const IDynamicToolProvider = createDecorator<DynamicToolProvider>(
  'activationTestDynamicToolProvider',
);
class DynamicToolProvider extends Service {
  declare readonly _serviceBrand: undefined;
  constructor() {
    super();
    this.provide(AgentToolContribution, {
      id: IGammaTool,
      ctor: GammaTool,
      options: { name: 'Gamma' },
    });
  }
}

const ICollectionProbe = createDecorator<CollectionProbe>('activationTestCollectionProbe');
class CollectionProbe extends Service {
  declare readonly _serviceBrand: undefined;
  constructor(
    @AgentToolContribution readonly view: CollectionView<AgentToolContribution>,
  ) {
    super();
  }
}

describe('AgentToolActivationService', () => {
  let savedContributions: readonly AgentToolContribution[];
  let disposables: DisposableStore;
  const profileData: {
    activeToolNames?: readonly string[];
    disallowedTools?: readonly string[];
  } = {};
  const gateData: { disabledTools: readonly string[] } = { disabledTools: [] };

  function createActivationHost() {
    disposables = new DisposableStore();
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentProfileService, {
          data: () => profileData as ProfileData,
        });
        reg.definePartialInstance(IEventBus, {
          subscribe: () => toDisposable(() => {}),
        });
        reg.defineInstance(ISessionToolPolicyGate, {
          _serviceBrand: undefined,
          get disabledTools() {
            return gateData.disabledTools;
          },
          onDidChange: Event.None as Event<void>,
        } satisfies ISessionToolPolicyGate);
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.define(IAgentToolActivationService, AgentToolActivationService);
        reg.define(IAlphaTool, AlphaTool);
        reg.define(IBetaTool, BetaTool);
        reg.define(IGammaTool, GammaTool);
      },
    });
    disposables.add(ix.createInstance(TestContributionAssembly));
    return ix;
  }

  beforeEach(() => {
    savedContributions = [...getAgentToolContributions()];
    disposables = new DisposableStore();
    alphaConstructions = 0;
    betaConstructions = 0;
    gammaConstructions = 0;
    _clearAgentToolContributionsForTests();
    delete profileData.activeToolNames;
    delete profileData.disallowedTools;
    gateData.disabledTools = [];
  });

  afterEach(() => {
    disposables.dispose();
    _clearAgentToolContributionsForTests();
    for (const contribution of savedContributions) {
      registerAgentToolService(contribution.id, contribution.ctor, contribution.options);
    }
  });

  it('keeps an AgentTool unconstructed during scope creation and resolves a real instance', () => {
    _clearScopedRegistryForTests();
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });

    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 'session');
    const agent = session.createChild(LifecycleScope.Agent, 'agent');

    expect(alphaConstructions).toBe(0);
    const tool = agent.accessor.get(IAlphaTool);
    expect(tool).toBeInstanceOf(AlphaTool);
    expect(alphaConstructions).toBe(1);
    app.dispose();
  });

  it('activates every contribution when the profile has no allowlist', async () => {
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeInstanceOf(BetaTool);
  });

  it('activates only the tools allowed by the profile allowlist', async () => {
    profileData.activeToolNames = ['Alpha'];
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();
    expect(betaConstructions).toBe(0);
  });

  it('honors the profile disallowedTools', async () => {
    profileData.disallowedTools = ['Beta'];
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();
    expect(betaConstructions).toBe(0);
  });

  it('skips contributions whose when predicate fails', async () => {
    registerAgentToolService(IGammaTool, GammaTool, { name: 'Gamma', when: () => false });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    expect(ix.get(IAgentToolRegistryService).resolve('Gamma')).toBeUndefined();
    expect(gammaConstructions).toBe(0);
  });

  it('honors the workspace tool-policy veto before the profile', async () => {
    gateData.disabledTools = ['Beta'];
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();
    expect(registry.list().map((t) => t.name)).not.toContain('Beta');
    expect(betaConstructions).toBe(0);
  });

  it('lets the workspace veto win over a profile allowlist', async () => {
    profileData.activeToolNames = ['Alpha', 'Beta'];
    gateData.disabledTools = ['Beta'];
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();

    await ix.get(IAgentToolActivationService).activate();

    const registry = ix.get(IAgentToolRegistryService);
    expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();
  });

  it('is idempotent and picks up newly allowed tools on re-activation', async () => {
    profileData.activeToolNames = ['Alpha'];
    registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
    registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
    const ix = createActivationHost();
    const activation = ix.get(IAgentToolActivationService);
    const registry = ix.get(IAgentToolRegistryService);

    await activation.activate();
    const alpha = registry.resolve('Alpha');
    expect(alpha).toBeInstanceOf(AlphaTool);
    expect(registry.resolve('Beta')).toBeUndefined();

    profileData.activeToolNames = ['Alpha', 'Beta'];
    await activation.activate();

    expect(registry.resolve('Alpha')).toBe(alpha);
    expect(registry.resolve('Beta')).toBeInstanceOf(BetaTool);
  });

  describe('collection fold (scoped tree)', () => {
    beforeEach(() => {
      _clearScopedRegistryForTests();
      registerScopedService(
        LifecycleScope.App,
        IBuiltinToolAssemblyService,
        BuiltinToolAssemblyService,
        ScopeActivation.OnScopeCreated,
        'toolRegistry',
      );
      registerScopedService(
        LifecycleScope.App,
        ICollectionProbe,
        CollectionProbe,
        ScopeActivation.OnDemand,
        'toolActivation',
      );
      registerScopedService(
        LifecycleScope.Agent,
        IAgentToolRegistryService,
        AgentToolRegistryService,
        ScopeActivation.OnScopeCreated,
        'toolRegistry',
      );
      registerScopedService(
        LifecycleScope.Agent,
        IAgentToolActivationService,
        AgentToolActivationService,
        ScopeActivation.OnScopeCreated,
        'toolActivation',
      );
      registerScopedService(
        LifecycleScope.Agent,
        IDynamicToolProvider,
        DynamicToolProvider,
        ScopeActivation.OnDemand,
        'toolActivation',
      );
    });

    function agentSeeds(extra: ScopeSeed = []): ScopeSeed {
      return [
        [IAgentProfileService, { data: () => profileData as ProfileData }],
        [IEventBus, { subscribe: () => toDisposable(() => {}) }],
        ...extra,
      ];
    }

    function createScopeTree(agentExtra: ScopeSeed = []) {
      const app = createAppScope();
      const session = app.createChild(LifecycleScope.Session, 'session', {
        extra: [
          [
            ISessionToolPolicyGate,
            {
              _serviceBrand: undefined,
              get disabledTools() {
                return gateData.disabledTools;
              },
              onDidChange: Event.None as Event<void>,
            } satisfies ISessionToolPolicyGate,
          ],
        ],
      });
      const agent = session.createChild(LifecycleScope.Agent, 'agent', {
        extra: agentSeeds(agentExtra),
      });
      return { app, session, agent };
    }

    it('activates the built-in records provided once at App scope, in every agent scope', async () => {
      registerAgentToolService(IAlphaTool, AlphaTool, { name: 'Alpha' });
      registerAgentToolService(IBetaTool, BetaTool, { name: 'Beta' });
      const { app, session, agent } = createScopeTree();
      expect(alphaConstructions).toBe(0);

      await agent.accessor.get(IAgentToolActivationService).activate();
      const registry = agent.accessor.get(IAgentToolRegistryService);
      expect(registry.resolve('Alpha')).toBeInstanceOf(AlphaTool);
      expect(registry.resolve('Beta')).toBeInstanceOf(BetaTool);

      const agent2 = session.createChild(LifecycleScope.Agent, 'agent-2', {
        extra: agentSeeds(),
      });
      await agent2.accessor.get(IAgentToolActivationService).activate();
      expect(agent2.accessor.get(IAgentToolRegistryService).resolve('Alpha')).toBeInstanceOf(
        AlphaTool,
      );
      app.dispose();
    });

    it('folds a unit-provided record incrementally and withdraws it when the provider dies', async () => {
      const { app, agent } = createScopeTree([[IGammaTool, new SyncDescriptor(GammaTool, [])]]);
      const registry = agent.accessor.get(IAgentToolRegistryService);
      const activation = agent.accessor.get(IAgentToolActivationService);

      await activation.activate();
      expect(registry.resolve('Gamma')).toBeUndefined();
      expect(gammaConstructions).toBe(0);

      const provider = agent.accessor.get(IDynamicToolProvider);
      expect(registry.resolve('Gamma')).toBeInstanceOf(GammaTool);
      expect(gammaConstructions).toBe(1);

      provider.dispose();
      expect(registry.resolve('Gamma')).toBeUndefined();
      await activation.activate();
      expect(registry.resolve('Gamma')).toBeUndefined();
      app.dispose();
    });

    it('feeds every built-in contribution through the App-scope assembly unchanged', async () => {
      expect(savedContributions).toHaveLength(21);
      for (const contribution of savedContributions) {
        registerAgentToolService(contribution.id, contribution.ctor, contribution.options);
      }
      profileData.activeToolNames = [];
      const { app, agent } = createScopeTree();

      const probe = app.accessor.get(ICollectionProbe);
      expect(probe.view.items).toHaveLength(savedContributions.length);
      const seenByName = new Map(probe.view.items.map((r) => [r.options.name, r] as const));
      for (const contribution of savedContributions) {
        const seen = seenByName.get(contribution.options.name);
        expect(seen?.id).toBe(contribution.id);
        expect(seen?.ctor).toBe(contribution.ctor);
        expect(seen?.options).toBe(contribution.options);
      }

      await agent.accessor.get(IAgentToolActivationService).activate();
      expect(agent.accessor.get(IAgentToolRegistryService).list()).toHaveLength(0);
      app.dispose();
    });
  });
});
