/**
 * `goal` domain (L4) — goal-mode driver (continuation turns + budget).
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
