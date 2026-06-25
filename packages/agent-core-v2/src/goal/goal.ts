/**
 * `goal` domain (L4) — active-goal tracking.
 *
 * Defines the public contract of goal mode: the `GoalState` model and the
 * `IGoalService` used to create, update, and clear the current goal.
 * Agent-scoped — one instance per agent.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface GoalState {
  readonly objective: string;
  readonly status: string;
}

export interface IGoalService {
  readonly _serviceBrand: undefined;
  readonly current: GoalState | undefined;
  create(objective: string): void;
  update(patch: Partial<GoalState>): void;
  clear(): void;
}

export const IGoalService: ServiceIdentifier<IGoalService> =
  createDecorator<IGoalService>('goalService');
