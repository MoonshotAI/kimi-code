/**
 * `turn` domain (L4) — `ILoopRunner` (Turn scope) skeleton.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { ILoopRunner } from './turn';

export class LoopRunner implements ILoopRunner {
  declare readonly _serviceBrand: undefined;
  run(): Promise<void> {
    // TODO: port the v1 `loop/` step engine (llm/tool/retry scheduling).
    return Promise.resolve();
  }
}

registerScopedService(LifecycleScope.Turn, ILoopRunner, LoopRunner, InstantiationType.Delayed, 'turn');
