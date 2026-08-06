/**
 * Plan-sample acceptance test — `plan/plan-domain-plugin.manifest.ts` as the
 * API acceptance standard (Phase 3 验证项), exercised against the REAL kernel
 * and the REAL domain collection tokens. Each section cites the sample line
 * it proves; the unload chain asserts §3's teardown order end to end.
 */

import { describe, expect, it } from 'vitest';

import { collection, type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { FiberState, ScopeUnits } from '#/_base/di/fiber';
import { createDecorator, ScopeActivation } from '#/_base/di/instantiation';
import { type InstantiationService } from '#/_base/di/instantiationService';
import { Scope } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ConfigSectionContribution } from '#/app/config/configSectionContributions';
import { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { WireModelContribution } from '#/wire/wireContribution';

interface IAgentPlanService {
  readonly _serviceBrand: undefined;
  marker: string;
}
const IAgentPlanService = createDecorator<IAgentPlanService>('plan-service');

interface IEnterPlanModeTool {
  marker: string;
}
const IEnterPlanModeTool = createDecorator<IEnterPlanModeTool>('enter-plan-mode-tool');

class AgentPlanService extends Service {
  readonly marker = 'plan-service';
}

class EnterPlanModeTool extends Service {
  readonly marker = 'enter-plan-mode';
  constructor(@IAgentPlanService readonly plan: IAgentPlanService) {
    super();
  }
}

const planProfile = { name: 'plan' } as never;

describe('Plan sample (plan-domain-plugin.manifest.ts) — API acceptance', () => {
  it('§1: the two Plan-domain units assemble through this.provide only', async () => {
    const log: string[] = [];

    class PlanFeature extends Service {
      static override readonly name = 'plan';

      constructor() {
        super();
        this.provide(ConfigSectionContribution, {
          domain: 'defaultPlanMode',
          schema: { '~standard': { validate: (v: unknown) => ({ value: v }) } } as never,
          options: { defaultValue: false } as never,
        });
        this.provide(AgentProfileContribution, {
          sourceId: 'builtin',
          contribution: { profiles: [planProfile] },
        });
        this.provide(ScopeUnits(LifecycleScope.Agent), PlanAgentFeature);
      }
    }

    class PlanAgentFeature extends Service {
      static override readonly name = 'plan/agent';

      constructor() {
        super();
        this.provide(WireModelContribution, { models: [], ops: [] });
        this.provide(IAgentPlanService, AgentPlanService, {
          activation: ScopeActivation.OnScopeCreated,
        });
        this.provide(AgentToolContribution, {
          id: IEnterPlanModeTool,
          ctor: EnterPlanModeTool,
          options: { name: 'EnterPlanMode' },
        } as unknown as AgentToolContribution);
        log.push('agent feature up');
      }
    }

    const seen: string[] = [];
    class ConfigFold extends Service {
      constructor(@ConfigSectionContribution view: CollectionView<unknown>) {
        super();
        for (const item of view.items) {
          seen.push(`config:${(item as { domain: string }).domain}`);
        }
        this._register(
          view.onDidChange(({ added, removed }) => {
            for (const item of added) seen.push(`config:+${(item as { domain: string }).domain}`);
            for (const item of removed) seen.push(`config:-${(item as { domain: string }).domain}`);
          }),
        );
      }
    }
    const IConfigFold = createDecorator<ConfigFold>('test-config-fold');
    const IPlanFeature = createDecorator<PlanFeature>('test-plan-feature');

    const app = Scope.createApp({ id: 'app' });
    app.instantiation.provide(IConfigFold, new SyncDescriptor(ConfigFold));
    app.accessor.get(IConfigFold);
    expect(seen).toEqual([]);

    const featureHandle = app.instantiation.provide(IPlanFeature, new SyncDescriptor(PlanFeature));
    app.accessor.get(IPlanFeature);

    expect(seen).toEqual(['config:+defaultPlanMode']);
    expect(featureHandle.uid).toBeTypeOf('number');

    const agent = app.createChild(LifecycleScope.Agent, 'agent-1');
    expect(log).toEqual(['agent feature up']);
    expect(agent.accessor.get(IAgentPlanService).marker).toBe('plan-service');
    const toolView = (agent.instantiation as InstantiationService).fiberHost.collectionView(AgentToolContribution);
    expect(toolView.items).toHaveLength(1);
    expect(toolView.items[0]!.options.name).toBe('EnterPlanMode');
    const wireView = (agent.instantiation as InstantiationService).fiberHost.collectionView(WireModelContribution);
    expect(wireView.items).toHaveLength(1);

    const tool = agent.instantiation.createInstance(EnterPlanModeTool);
    expect(tool.plan.marker).toBe('plan-service');

    featureHandle.dispose();
    await app.instantiation.cascade.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((agent.instantiation as InstantiationService).fiberHost.collectionView(WireModelContribution).items).toHaveLength(0);
    expect(toolView.items).toHaveLength(0);
    expect(seen).toEqual(['config:+defaultPlanMode', 'config:-defaultPlanMode']);
    expect(log).toEqual(['agent feature up']);
    expect(() => agent.accessor.get(IAgentPlanService)).toThrow();
    agent.dispose();
    app.dispose();
  });

  it('§0: class-recipe statics (name) and handle state are honored', () => {
    class Named extends Service {
      static override readonly name = 'plan';
    }
    const INamed = createDecorator<Named>('test-named');
    const app = Scope.createApp({ id: 'app' });
    const handle = app.instantiation.provide(INamed, new SyncDescriptor(Named));
    app.accessor.get(INamed);
    expect(handle.uid).toBeTypeOf('number');
    expect(app.instantiation.cascade.stateOf(INamed)).toBe('Active');
    app.dispose();
  });

  it('§1: FiberHandle for a unit provide is thenable and Active', async () => {
    const IPlan = createDecorator<Service>('test-plan-handle');
    class PlanFeature extends Service {
      static override readonly name = 'plan';
    }
    const app = Scope.createApp({ id: 'app' });
    app.instantiation.provide(IPlan, new SyncDescriptor(PlanFeature));
    const unit = app.accessor.get(IPlan);
    expect(unit.state).toBe(FiberState.Active);
    expect(unit.name).toBe('plan');
    app.dispose();
  });
});
