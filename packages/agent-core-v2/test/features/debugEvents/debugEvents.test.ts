import { beforeEach, describe, expect, it } from 'vitest';

import { ScopeActivation } from '#/_base/di/instantiation';
import {
  _clearScopedRegistryForTests,
  getScopedServiceDescriptors,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { LifecycleScope } from '#/app/scopes';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';

import { IDebugEventsService } from '#/features/debugEvents/debugEvents';
import { DebugEventsFeature } from '#/features/debugEvents/debugEventsFeature';

describe('DebugEventsFeature — App-scope introspection service', () => {
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
    registerFeature(DebugEventsFeature);
  });

  it('contributes IDebugEventsService at App scope outside the static scoped registry', async () => {
    expect(
      getScopedServiceDescriptors(LifecycleScope.App).some(
        (entry) => entry.id.toString() === 'debugEventsService',
      ),
    ).toBe(false);

    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toContain('debugEvents');

    const result = host.app.accessor.get(IDebugEventsService).subscriptions();
    expect(result).toMatchObject({
      subscriptions: expect.any(Array),
      buses: expect.any(Array),
    });

    await manager.unprovideUnit('debugEvents');
    await host.app.instantiation.cascade.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => host.app.accessor.get(IDebugEventsService)).toThrow();
    host.dispose();
  });
});
