import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { IAgentPlanService } from './plan';
import { AgentPlanService } from './planService';
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  IExitPlanModeTool,
} from './tools/exit-plan-mode/exit-plan-mode';
import { ExitPlanModeTool } from './tools/exit-plan-mode/exitPlanModeTool';

export class PlanFeature extends Feature {
  static override readonly name = 'plan';

  constructor() {
    super();
    this.contributeAgentService(IAgentPlanService, AgentPlanService);
    this.contributeTool(IExitPlanModeTool, ExitPlanModeTool, {
      name: EXIT_PLAN_MODE_TOOL_NAME,
      domain: 'plan',
    });
  }
}

registerFeature(PlanFeature);
