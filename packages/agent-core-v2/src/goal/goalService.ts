/**
 * `goal` domain (L4) — `IGoalService` implementation.
 *
 * Holds the active goal state; enqueues follow-up through `injection`,
 * persists records through `records`, and observes turns through `turn`. Bound
 * at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IInjectionService } from '#/injection/injection';
import { IAgentRecords } from '#/records/records';
import { ITurnService } from '#/turn/turn';

import { type GoalState, IGoalService } from './goal';

export class GoalService extends Disposable implements IGoalService {
  declare readonly _serviceBrand: undefined;
  private state: GoalState | undefined;

  constructor(
    @IAgentRecords _records: IAgentRecords,
    @ITurnService turn: ITurnService,
    @IInjectionService _injection: IInjectionService,
  ) {
    super();
    this._register(turn.onDidEndTurn(() => {}));
  }

  get current(): GoalState | undefined {
    return this.state;
  }

  create(objective: string): void {
    this.state = { objective, status: 'active' };
  }
  update(patch: Partial<GoalState>): void {
    if (this.state === undefined) return;
    this.state = { ...this.state, ...patch };
  }
  clear(): void {
    this.state = undefined;
  }
}

registerScopedService(LifecycleScope.Agent, IGoalService, GoalService, InstantiationType.Delayed, 'goal');
