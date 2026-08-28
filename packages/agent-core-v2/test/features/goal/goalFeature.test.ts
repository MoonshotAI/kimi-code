import { beforeEach, describe, expect, it } from 'vitest';

import { ScopeActivation } from '#/_base/di/instantiation';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import type { LoopControl } from '#/features/loop/internal/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { AgentTools } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { GoalFeature } from '#/features/goal/goalFeature';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IEventDispatcher } from '#/state/eventDispatcher';
const LifecycleScope = { App: 'app', Session: 'session', Agent: 'agent' } as const;

describe('GoalFeature', () => {
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
    registerFeature(GoalFeature);
  });

  it('assembles a named, introspectable goal unit', () => {
    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);
    expect(manager.units().map((unit) => unit.name)).toContain('goal');
    host.dispose();
  });

  it('retracts the goal runtime contribution with the Feature', async () => {
    const host = createScopedTestHost();
    const manager = host.app.accessor.get(IFeatureManager);

    await manager.unprovideUnit('goal');
    await host.app.instantiation.cascade.whenIdle();
    expect(manager.units().map((unit) => unit.name)).not.toContain('goal');

    manager.provideUnit(GoalFeature);
    await host.app.instantiation.cascade.whenIdle();
    expect(manager.units().map((unit) => unit.name)).toContain('goal');

    host.dispose();
  });
});
