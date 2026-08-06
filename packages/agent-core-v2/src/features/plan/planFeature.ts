/**
 * `plan` domain — `PlanFeature`: the plan-mode capability assembled as one
 * App-scope Feature unit.
 *
 * Contributes the per-Agent `IAgentPlanService` and the `EnterPlanMode` /
 * `ExitPlanMode` agent tools through the `features` base-class seams;
 * retracting the unit withdraws all of them across the scope tree. The
 * `defaultPlanMode` config section (`features/plan/configSection`), the
 * `plan` agent profile (`features/plan/profile`), and the `plan_mode.*` /
 * `plan.revision` wire vocabulary (`features/plan/planOps`) stay on their
 * static import=register channels — user-facing contracts must remain
 * statically discoverable (config manifest) and wire records replayable even
 * when the feature unit is retracted. Registered into the feature table at
 * import.
 */

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
