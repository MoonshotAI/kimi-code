/**
 * `turn` domain (L4) — `ILoopRunner` implementation.
 *
 * Runs the per-turn loop. Bound at Turn scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { ILoopRunner } from './turn';

export class LoopRunner implements ILoopRunner {
  declare readonly _serviceBrand: undefined;
  run(): Promise<void> {
    return Promise.resolve();
  }
}

registerScopedService(LifecycleScope.Turn, ILoopRunner, LoopRunner, InstantiationType.Delayed, 'turn');
