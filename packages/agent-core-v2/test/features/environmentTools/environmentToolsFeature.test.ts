import { beforeEach, describe, expect, it } from 'vitest';

import { type CollectionToken, type CollectionView } from '#/_base/di/collection';
import { ScopeActivation } from '#/_base/di/instantiation';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import { _clearScopedRegistryForTests, registerScopedService, type Scope } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { AgentEnvironmentToolsFeature } from '#/features/environmentTools/environmentToolsFeature';
import { AGENT_ENVIRONMENT_TOOLS_FLAG_ID } from '#/features/environmentTools/flag';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';
import { IAgentTowerService } from '#/features/tower/tower';

import { stubFlag } from '../../app/flag/stubs';

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

function towerAccessor(isActive: boolean): ServicesAccessor {
  return {
    get: (id: unknown) => {
      if (id === IAgentTowerService) return { isActive };
      throw new Error(`unexpected service request ${String(id)}`);
    },
  } as unknown as ServicesAccessor;
}

describe('AgentEnvironmentToolsFeature — experimental flag gating', () => {
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
    registerFeature(AgentEnvironmentToolsFeature);
  });

  it('assembles an empty unit when the agent_environment_tools flag is off', () => {
    const host = createScopedTestHost([[IFlagService, stubFlag(false)]]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toEqual(['agentEnvironmentTools']);
    expect(manager.contributedServices()).toHaveLength(0);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    expect(collectionViewOf(agent, AgentToolContribution).items).toHaveLength(0);
    host.dispose();
  });

  it('contributes the environment tool group when the flag is on', () => {
    const host = createScopedTestHost([
      [IFlagService, stubFlag((id) => id === AGENT_ENVIRONMENT_TOOLS_FLAG_ID)],
    ]);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    const records = collectionViewOf(agent, AgentToolContribution).items;
    expect(records.map((record) => record.options.name).toSorted()).toEqual(
      ['change_environment', 'connect'].toSorted(),
    );
    for (const record of records) {
      expect(record.options.when?.(towerAccessor(false))).toBe(true);
      expect(record.options.when?.(towerAccessor(true))).toBe(false);
    }
    host.dispose();
  });
});
