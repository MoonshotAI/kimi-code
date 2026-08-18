import { beforeEach, describe, expect, it } from 'vitest';

import { type CollectionToken, type CollectionView } from '#/_base/di/collection';
import { ScopeActivation } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { FLOW_FLAG_ID, FLOW_REVIEWER_PROFILE } from '#/features/flow/flow';
import { FlowFeature } from '#/features/flow/flowFeature';
import { IFlowInjection } from '#/features/flow/injection/flowInjection';

import { stubFlag } from '../../app/flag/stubs';

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

describe('FlowFeature — experimental flag gating', () => {
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
    registerFeature(FlowFeature);
  });

  it('assembles an empty unit when the flow flag is off', () => {
    const host = createScopedTestHost([[IFlagService, stubFlag(false)]]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toEqual(['flow']);
    expect(manager.contributedServices()).toHaveLength(0);
    expect(collectionViewOf(host.app, AgentProfileContribution).items).toHaveLength(0);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    expect(collectionViewOf(agent, AgentToolContribution).items).toHaveLength(0);
    host.dispose();
  });

  it('contributes tools, the reviewer profile, and the injection service when the flow flag is on', () => {
    const host = createScopedTestHost([
      [IFlagService, stubFlag((id) => id === FLOW_FLAG_ID)],
    ]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(
      manager
        .contributedServices()
        .filter((entry) => entry.scope === LifecycleScope.Agent && entry.id === IFlowInjection),
    ).toHaveLength(1);
    const profiles = collectionViewOf(host.app, AgentProfileContribution).items;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.sourceId).toBe('feature:flow');
    expect(profiles[0]!.contribution.profiles.map((profile) => profile.name)).toEqual([
      FLOW_REVIEWER_PROFILE,
    ]);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    const tools = collectionViewOf(agent, AgentToolContribution).items.map(
      (record) => record.options.name,
    );
    expect(tools.toSorted()).toEqual(['FlowAbort', 'FlowAdvance', 'FlowStart']);
    host.dispose();
  });
});
