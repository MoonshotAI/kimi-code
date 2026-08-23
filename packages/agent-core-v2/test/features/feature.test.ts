import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type CollectionToken,
  type CollectionView,
} from '#/_base/di/collection';
import { ScopeUnits } from '#/_base/di/fiber';
import { createDecorator, ScopeActivation } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import {
  _clearScopedRegistryForTests,
  getScopedServiceDescriptors,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { createScopedTestHost } from '#/_base/di/test';
import { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { ConfigSectionContribution } from '#/app/config/configSectionContributions';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { LifecycleScope } from '#/app/scopes';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { Feature } from '#/features/feature';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  AgentEffectContribution,
  defineAgentEffect,
  SessionEffectContribution,
  type AgentEffectDefinition,
  type SessionEffectDefinition,
} from '#/state/agentEffect';
import {
  AgentModel,
  AgentModelContribution,
  defineAgentModel,
  SessionModelContribution,
  type SessionModelDefinition,
} from '#/state/agentModel';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';

interface IGreeter {
  readonly _serviceBrand: undefined;
  greet(): string;
}
const IGreeter = createDecorator<IGreeter>('test-feature-greeter');

class GreeterService extends Service implements IGreeter {
  declare readonly _serviceBrand: undefined;
  greet(): string {
    return 'hi';
  }
}

interface ITestTool extends AgentTool {}
const ITestTool = createDecorator<ITestTool>('test-feature-tool');

class TestTool implements ITestTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TestTool';
  readonly description = 'test tool';
  readonly parameters = {};

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => ({ output: '' }),
    };
  }
}

const TestConfigSchema = {
  '~standard': {
    validate: (value: unknown) => ({ value }),
  },
} as never;

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

describe('Feature — built-in capability assembly (src/features)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
  });

  it('assembles a registered feature and materializes its contributions per Agent scope', async () => {
    const disposed: string[] = [];

    class TestFeature extends Feature {
      static override readonly name = 'test-feature';

      constructor() {
        super();
        this.contributeConfig('testFeatureSection', TestConfigSchema, { defaultValue: false });
        this.contributeAgentService(IGreeter, GreeterService);
        this.contributeTool(ITestTool, TestTool, { name: 'TestTool' });
        this.contributeProfiles([{ name: 'test-profile' } as never]);
        this.onDispose(() => disposed.push('test-feature'));
      }
    }
    registerFeature(TestFeature);

    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units()).toHaveLength(1);
    expect(manager.units()[0]!.name).toBe('test-feature');

    const configView = collectionViewOf(host.app, ConfigSectionContribution);
    expect(configView.items.map((item) => item.domain)).toContain('testFeatureSection');

    const profileView = collectionViewOf(host.app, AgentProfileContribution);
    expect(profileView.items).toHaveLength(1);
    expect(profileView.items[0]!.sourceId).toBe('feature:test-feature');

    const agentOne = host.child(LifecycleScope.Agent, 'agent-1');
    const agentTwo = host.child(LifecycleScope.Agent, 'agent-2');
    expect(agentOne.accessor.get(IGreeter).greet()).toBe('hi');
    expect(agentTwo.accessor.get(IGreeter).greet()).toBe('hi');
    expect(agentOne.accessor.get(IGreeter)).not.toBe(agentTwo.accessor.get(IGreeter));

    const toolView = collectionViewOf(agentOne, AgentToolContribution);
    expect(toolView.items).toHaveLength(1);
    expect(toolView.items[0]!.options.name).toBe('TestTool');
    expect(agentOne.accessor.get(ITestTool).name).toBe('TestTool');

    await manager.unprovideUnit('test-feature');
    await host.app.instantiation.cascade.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.units()).toHaveLength(0);
    expect(disposed).toEqual(['test-feature']);
    expect(configView.items.map((item) => item.domain)).not.toContain('testFeatureSection');
    expect(profileView.items).toHaveLength(0);
    expect(toolView.items).toHaveLength(0);
    expect(() => agentOne.accessor.get(IGreeter)).toThrow();
    expect(() => agentOne.accessor.get(ITestTool)).toThrow();

    host.dispose();
  });

  it('registers model and effect definitions without materializing them', async () => {
    let creates = 0;
    const sessionModel: SessionModelDefinition<number> = {
      id: 'test-feature.session-model',
      state: { initial: () => 0, schema: z.custom<number>() },
      events: [],
      undoable: false,
    };
    const agentModel = defineAgentModel({
      id: 'test-feature.agent-model',
      model: class extends AgentModel<number> {},
      state: { initial: () => 0, schema: z.custom<number>() },
      events: [],
    });
    const sessionEffect: SessionEffectDefinition = {
      id: 'test-feature.session-effect',
      create: () => {
        creates += 1;
        return { dispose: () => {} };
      },
    };
    const agentEffect: AgentEffectDefinition<any, any> = defineAgentEffect({
      id: 'test-feature.agent-effect',
      create: () => {
        creates += 1;
        return { dispose: () => {} };
      },
    });
    class DomainFeature extends Feature {
      static override readonly name = 'domain-definitions';

      constructor() {
        super();
        this.contributeSessionModel(sessionModel);
        this.contributeAgentModel(agentModel);
        this.contributeSessionEffect(sessionEffect);
        this.contributeAgentEffect(agentEffect);
      }
    }
    class ReplacementFeature extends Feature {
      static override readonly name = 'replacement-definitions';

      constructor() {
        super();
        this.contributeAgentModel(agentModel);
      }
    }
    registerFeature(DomainFeature);

    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);
    const views = [
      collectionViewOf(host.app, SessionModelContribution),
      collectionViewOf(host.app, AgentModelContribution),
      collectionViewOf(host.app, SessionEffectContribution),
      collectionViewOf(host.app, AgentEffectContribution),
    ];
    expect(views.map((view) => view.items)).toEqual([
      [sessionModel],
      [agentModel],
      [sessionEffect],
      [agentEffect],
    ]);
    expect(creates).toBe(0);
    expect(() => manager.provideUnit(ReplacementFeature)).toThrow(
      "Agent model 'test-feature.agent-model' already has an active provider",
    );

    await manager.unprovideUnit('domain-definitions');
    await host.app.instantiation.cascade.whenIdle();
    expect(views.every((view) => view.items.length === 0)).toBe(true);
    expect(() => manager.provideUnit(ReplacementFeature)).not.toThrow();
    expect(creates).toBe(0);
    host.dispose();
  });

  it('rejects duplicate service contributions until the provider unloads', async () => {
    class FirstFeature extends Feature {
      static override readonly name = 'first-feature';

      constructor() {
        super();
        this.contributeAgentService(IGreeter, GreeterService);
      }
    }
    class SecondFeature extends Feature {
      static override readonly name = 'second-feature';

      constructor() {
        super();
        this.contributeAgentService(IGreeter, GreeterService);
      }
    }
    registerFeature(FirstFeature);

    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    const original = agent.accessor.get(IGreeter);
    expect(() => manager.provideUnit(SecondFeature)).toThrow(
      /Service test-feature-greeter is already contributed at scope agent/,
    );
    expect(manager.units().map((unit) => unit.name)).toEqual(['first-feature']);
    expect(
      manager
        .contributedServices()
        .filter((entry) => entry.scope === LifecycleScope.Agent && entry.id === IGreeter),
    ).toHaveLength(1);
    expect(collectionViewOf(host.app, ScopeUnits(LifecycleScope.Agent)).items).toHaveLength(1);
    expect(agent.accessor.get(IGreeter)).toBe(original);

    await manager.unprovideUnit('first-feature');
    await host.app.instantiation.cascade.whenIdle();
    expect(() => manager.provideUnit(SecondFeature)).not.toThrow();
    expect(manager.units().map((unit) => unit.name)).toEqual(['second-feature']);
    expect(agent.accessor.get(IGreeter).greet()).toBe('hi');

    host.dispose();
  });

  it('isolates equal service contributions between App roots', async () => {
    class SharedFeature extends Feature {
      static override readonly name = 'shared-feature';

      constructor() {
        super();
        this.contributeAgentService(IGreeter, GreeterService);
      }
    }
    registerFeature(SharedFeature);

    const first = createScopedTestHost();
    const second = createScopedTestHost();
    const firstManager = first.app.accessor.get(IFeatureManager);
    const secondManager = second.app.accessor.get(IFeatureManager);
    const firstAgent = first.child(LifecycleScope.Agent, 'agent-1');
    const secondAgent = second.child(LifecycleScope.Agent, 'agent-1');
    expect(firstManager.contributedServices()).toHaveLength(1);
    expect(secondManager.contributedServices()).toHaveLength(1);
    expect(firstAgent.accessor.get(IGreeter)).not.toBe(secondAgent.accessor.get(IGreeter));

    await firstManager.unprovideUnit('shared-feature');
    await first.app.instantiation.cascade.whenIdle();
    expect(firstManager.contributedServices()).toHaveLength(0);
    expect(secondManager.contributedServices()).toHaveLength(1);
    expect(() => firstAgent.accessor.get(IGreeter)).toThrow();
    expect(secondAgent.accessor.get(IGreeter).greet()).toBe('hi');

    first.dispose();
    second.dispose();
  });

  it('materializes a per-scope class recipe contributed through contribute()', () => {
    class SoloAgentUnit extends Service {
      static override readonly name = 'solo-feature/agent';

      constructor() {
        super();
        this.provide(IGreeter, GreeterService);
      }
    }
    class SoloFeature extends Feature {
      static override readonly name = 'solo-feature';

      constructor() {
        super();
        this.contribute(ScopeUnits(LifecycleScope.Agent), SoloAgentUnit);
      }
    }
    registerFeature(SoloFeature);

    const host = createScopedTestHost();
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    expect(agent.accessor.get(IGreeter).greet()).toBe('hi');
    host.dispose();
  });
});
