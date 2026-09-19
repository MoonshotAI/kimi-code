import { beforeEach, describe, expect, it } from 'vitest';

import { type CollectionToken, type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { ScopeActivation } from '#/_base/di/instantiation';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import { _clearScopedRegistryForTests, registerScopedService, type Scope } from '#/_base/di/scope';
import { createScopedTestHost, TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { IFlagRegistry } from '#/app/flag/flagRegistry';
import { FlagRegistryService } from '#/app/flag/flagRegistryService';
import { FlagService } from '#/app/flag/flagService';
import { LifecycleScope } from '#/app/scopes';
import { AgentEnvironmentToolsFeature } from '#/features/environmentTools/environmentToolsFeature';
import { AGENT_ENVIRONMENT_TOOLS_FLAG_ID } from '#/features/environmentTools/flag';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';
import { IAgentTowerService } from '#/features/tower/tower';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';
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

  it('contributes change_environment and connect by default when nothing overrides the flag', () => {
    const ix = new TestInstantiationService();
    ix.stub(IBootstrapService, stubBootstrap());
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IFlagRegistry, new SyncDescriptor(FlagRegistryService));
    ix.set(IFlagService, new SyncDescriptor(FlagService));
    const flags = ix.get(IFlagService);
    expect(flags.explain(AGENT_ENVIRONMENT_TOOLS_FLAG_ID)?.source).toBe('default');
    expect(flags.enabled(AGENT_ENVIRONMENT_TOOLS_FLAG_ID)).toBe(true);

    const host = createScopedTestHost([[IFlagService, flags]]);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    const records = collectionViewOf(agent, AgentToolContribution).items;
    expect(records.map((record) => record.options.name).toSorted()).toEqual(
      ['change_environment', 'connect'].toSorted(),
    );
    host.dispose();
    ix.dispose();
  });
});
