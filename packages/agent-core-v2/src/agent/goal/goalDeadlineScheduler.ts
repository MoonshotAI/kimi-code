/**
 * `goal` domain (L4) — wall-clock deadline scheduling contract.
 *
 * Defines the App-scoped `IGoalDeadlineScheduler` used by per-agent goal
 * services to measure active time and arm hard wall-clock budget deadlines.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export interface IGoalDeadlineScheduler {
  readonly _serviceBrand: undefined;

  now(): number;
  schedule(delayMs: number, callback: () => void): IDisposable;
}

export const IGoalDeadlineScheduler: ServiceIdentifier<IGoalDeadlineScheduler> =
  createDecorator<IGoalDeadlineScheduler>('goalDeadlineScheduler');
