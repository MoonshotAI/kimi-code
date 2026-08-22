import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CollectionToken, type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { ScopeActivation } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { TestInstantiationService, createScopedTestHost } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { EXPERIMENTAL_SECTION, IFlagService } from '#/app/flag/flag';
import { IFlagRegistry } from '#/app/flag/flagRegistry';
import { FlagRegistryService } from '#/app/flag/flagRegistryService';
import { FlagService, MASTER_ENV } from '#/app/flag/flagService';
import { LifecycleScope } from '#/app/scopes';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { TOWER_FLAG_ID } from '#/features/tower/tower';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import {
  TowerFeature,
  isTowerFeatureAssembled,
} from '#/features/tower/towerFeature';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubFlag } from '../../app/flag/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

function collectionViewOf<T>(scope: Scope, token: CollectionToken<T>): CollectionView<T> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(token);
}

describe('TowerFeature — experimental flag gating', () => {
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
    registerFeature(TowerFeature);
  });

  it('assembles an empty unit when the tower flag is off', () => {
    const host = createScopedTestHost([[IFlagService, stubFlag(false)]]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toEqual(['tower']);
    expect(manager.contributedServices()).toHaveLength(0);
    expect(collectionViewOf(host.app, AgentProfileContribution).items).toHaveLength(0);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    expect(collectionViewOf(agent, AgentToolContribution).items).toHaveLength(0);
    host.dispose();
  });

  it('contributes tools, profile, and rate-limit service when the tower flag is on', () => {
    const host = createScopedTestHost([
      [IFlagService, stubFlag((id) => id === TOWER_FLAG_ID)],
    ]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(
      manager
        .contributedServices()
        .filter(
          (entry) => entry.scope === LifecycleScope.App && entry.id === ITowerRateLimitService,
        ),
    ).toHaveLength(1);
    const profiles = collectionViewOf(host.app, AgentProfileContribution).items;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.sourceId).toBe('feature:tower');
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    const tools = collectionViewOf(agent, AgentToolContribution).items.map((record) =>
      record.options.name,
    );
    expect(tools.toSorted()).toEqual(
      [
        'TowerFinding',
        'TowerInbox',
        'TowerInit',
        'TowerMerge',
        'TowerMission',
        'TowerPlan',
        'TowerReview',
        'TowerSend',
        'TowerSpawn',
        'TowerStatus',
        'TowerTeardown',
      ].toSorted(),
    );
    host.dispose();
  });

  it('clears the assembly marker when the feature unit unloads', async () => {
    const flags = stubFlag((id) => id === TOWER_FLAG_ID);
    const host = createScopedTestHost([[IFlagService, flags]]);
    const manager = host.app.accessor.get(IFeatureManager);
    expect(isTowerFeatureAssembled(flags)).toBe(true);

    await manager.unprovideUnit('tower');

    expect(isTowerFeatureAssembled(flags)).toBe(false);
    host.dispose();
  });
});

describe('tower flag — hard-disabled (no declaration registered)', () => {
  let disposables: DisposableStore;
  let homeDir: string;

  beforeEach(() => {
    disposables = new DisposableStore();
    homeDir = `/tmp/kimi-code-tower-flag-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });
  afterEach(() => disposables.dispose());

  function makeFlags(env: Readonly<Record<string, string | undefined>> = {}) {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IBootstrapService, stubBootstrap(homeDir, env));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IFlagRegistry, new SyncDescriptor(FlagRegistryService));
    ix.set(IFlagService, new SyncDescriptor(FlagService));
    return { config: ix.get(IConfigService), flags: ix.get(IFlagService) };
  }

  it('cannot be enabled by the dedicated or master env while no tower flag is registered', () => {
    const { flags } = makeFlags({
      KIMI_CODE_EXPERIMENTAL_TOWER: 'true',
      [MASTER_ENV]: 'true',
    });
    expect(flags.explain(TOWER_FLAG_ID)).toBeUndefined();
    expect(flags.enabled(TOWER_FLAG_ID)).toBe(false);
  });

  it('cannot be enabled through the [experimental] config section', async () => {
    const { config, flags } = makeFlags();
    await config.set(EXPERIMENTAL_SECTION, { [TOWER_FLAG_ID]: true });
    expect(flags.explain(TOWER_FLAG_ID)).toBeUndefined();
    expect(flags.enabled(TOWER_FLAG_ID)).toBe(false);
  });
});
