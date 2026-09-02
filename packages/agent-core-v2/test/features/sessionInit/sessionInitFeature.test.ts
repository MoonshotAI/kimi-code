import { beforeEach, describe, expect, it } from 'vitest';

import { ScopeActivation } from '#/_base/di/instantiation';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { LifecycleScope } from '#/app/scopes';
import { SessionInitFeature } from '#/features/sessionInit/sessionInitFeature';
import { ISessionInitService } from '#/features/sessionInit/sessionInit';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSubagentService } from '#/session/subagent/subagent';

describe('SessionInitFeature', () => {
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
    registerFeature(SessionInitFeature);
  });

  it('withdraws and restores the Session service with the Feature', async () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 'session-1', [
      stubPair(IAgentLifecycleService, {} as IAgentLifecycleService),
      stubPair(ISessionSubagentService, {} as ISessionSubagentService),
      stubPair(IHostFileSystem, {} as IHostFileSystem),
      stubPair(IHostEnvironment, {} as IHostEnvironment),
      stubPair(IBootstrapService, {} as IBootstrapService),
      stubPair(ISessionContext, {} as ISessionContext),
    ]);
    const manager = host.app.accessor.get(IFeatureManager);

    expect(session.accessor.get(ISessionInitService)).toBeDefined();

    await manager.unprovideUnit('sessionInit');
    await host.app.instantiation.cascade.whenIdle();
    expect(() => session.accessor.get(ISessionInitService)).toThrow();

    manager.provideUnit(SessionInitFeature);
    await host.app.instantiation.cascade.whenIdle();
    expect(session.accessor.get(ISessionInitService)).toBeDefined();

    host.dispose();
  });
});
