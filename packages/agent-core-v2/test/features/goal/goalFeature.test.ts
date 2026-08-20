import { beforeEach, describe, expect, it } from 'vitest';

import { ScopeActivation } from '#/_base/di/instantiation';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import {
  _clearFeatureRecipesForTests,
  registerFeature,
} from '#/features/featureRegistry';
import { IAgentGoalService } from '#/features/goal/goal';
import { GoalFeature } from '#/features/goal/goalFeature';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IEventDispatcher } from '#/state/eventDispatcher';

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

  it('resolves and retracts IAgentGoalService in the Agent scope with the Feature', async () => {
    const host = createScopedTestHost();
    const agent = host.child(LifecycleScope.Agent, 'agent-1', [
      stubPair(IEventDispatcher, {} as IEventDispatcher),
      stubPair(IEventBus, {} as IEventBus),
      stubPair(IAgentSystemReminderService, {} as IAgentSystemReminderService),
      stubPair(ITelemetryService, {} as ITelemetryService),
      stubPair(IAgentContextInjectorService, {} as IAgentContextInjectorService),
      stubPair(IAgentLoopService, {} as IAgentLoopService),
      stubPair(IAgentToolExecutorService, {} as IAgentToolExecutorService),
      stubPair(IAgentToolRegistryService, {} as IAgentToolRegistryService),
      stubPair(IAgentToolPolicyService, {} as IAgentToolPolicyService),
      stubPair(IAgentToolApprovalService, {} as IAgentToolApprovalService),
      stubPair(IAgentPermissionModeService, {} as IAgentPermissionModeService),
      stubPair(ISessionUsageService, {} as ISessionUsageService),
      stubPair(IConfigService, {} as IConfigService),
      stubPair(IFlagService, {} as IFlagService),
      stubPair(IAgentScopeContext, {
        _serviceBrand: undefined,
        agentId: 'sub-1',
      } as IAgentScopeContext),
      stubPair(IAgentStateService, {
        contributeState: () => undefined,
      } as unknown as IAgentStateService),
    ]);
    const manager = host.app.accessor.get(IFeatureManager);

    expect(agent.accessor.get(IAgentGoalService)).toBeDefined();

    await manager.unprovideUnit('goal');
    await host.app.instantiation.cascade.whenIdle();
    expect(() => agent.accessor.get(IAgentGoalService)).toThrow();

    manager.provideUnit(GoalFeature);
    await host.app.instantiation.cascade.whenIdle();
    expect(agent.accessor.get(IAgentGoalService)).toBeDefined();

    host.dispose();
  });
});
