import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { IAgentPlanService } from './plan';
import { AgentPlanService } from './planService';
import { IEnterPlanModeTool } from './tools/enter-plan-mode/enter-plan-mode';
import { EnterPlanModeTool } from './tools/enter-plan-mode/enterPlanModeTool';
import { IExitPlanModeTool } from './tools/exit-plan-mode/exit-plan-mode';
import { ExitPlanModeTool } from './tools/exit-plan-mode/exitPlanModeTool';

export class PlanFeature extends Feature {
  static override readonly name = 'plan';

  constructor() {
    super();
    this.contributeAgentService(IAgentPlanService, AgentPlanService);
    this.contributeTool(IEnterPlanModeTool, EnterPlanModeTool, {
      name: 'EnterPlanMode',
      domain: 'plan',
    });
    this.contributeTool(IExitPlanModeTool, ExitPlanModeTool, {
      name: 'ExitPlanMode',
      domain: 'plan',
    });
  }
}

registerFeature(PlanFeature);
