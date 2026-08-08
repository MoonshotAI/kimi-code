import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Tower mode never tracks missions in TodoList: the tower protocol
 * (TowerPlan / TowerMission / TowerStatus, MISSIONS.md) is the mission
 * tracker, and todo semantics ("keep exactly one task in_progress") push the
 * tower to run one mission at a time — serializing a fleet that exists to
 * run in parallel. This is the code guarantee behind the skill rule, active
 * in every permission mode for as long as tower mode is on. Workers are
 * unaffected: they never enter tower mode, and their own TodoList use is
 * legitimate.
 */
export class TowerModeTodoListDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'tower-mode-todo-list-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.towerMode?.isActive) return;
    if (context.toolCall.name !== 'TodoList') return;
    return {
      kind: 'deny',
      message:
        'TodoList is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.',
    };
  }
}
