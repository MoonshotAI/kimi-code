import { beforeEach, describe, expect, it } from 'vitest';

import { type CollectionToken, type CollectionView } from '#/_base/di/collection';
import { ScopeUnits } from '#/_base/di/fiber';
import { createDecorator, ScopeActivation } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import {
  _clearScopedRegistryForTests,
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
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';
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
