/**
 * `plan` domain barrel — re-exports the plan contract (`plan`) and its scoped
 * service (`planService`), plus side-effect imports of the plan profile and each
 * plan tool so their contribution calls run at module load. Importing this barrel
 * wires `IAgentPlanService` into the scope registry, registers the `plan` agent
 * profile, and adds `EnterPlanMode` / `ExitPlanMode` to the tool contribution list.
 */

import './profile';
import './tools/enter-plan-mode';
import './tools/exit-plan-mode';

export * from './plan';
export * from './planService';
