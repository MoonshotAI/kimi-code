import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import './configSection';
import { EnterPlanModeTool } from './tools/enter-plan-mode/enterPlanModeTool';
import { ExitPlanModeTool } from './tools/exit-plan-mode/exitPlanModeTool';
import { ISessionPlanService, SessionPlanService } from './sessionPlanService';

export class PlanFeature extends Feature {
  static override readonly name = 'plan';

  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, ISessionPlanService, SessionPlanService);
    this.contributeTool({
      name: 'EnterPlanMode',
      domain: 'plan',
      create: (ctx) =>
        new EnterPlanModeTool(ctx.get(ISessionPlanService).of(ctx.agent), ctx.host.telemetry),
    });
    this.contributeTool({
      name: 'ExitPlanMode',
      domain: 'plan',
      create: (ctx) =>
        new ExitPlanModeTool(
          ctx.get(ISessionPlanService).of(ctx.agent),
          ctx.get(IAgentLifecycleService),
          ctx.host.scopeContext,
          ctx.host.telemetry,
        ),
    });
  }
}

registerFeature(PlanFeature);
