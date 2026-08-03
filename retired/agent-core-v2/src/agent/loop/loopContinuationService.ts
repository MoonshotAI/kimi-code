/**
 * `loop` domain (L4) — tool-step continuation aspect.
 *
 * A step that executed tools must drive one more step so the model consumes
 * the tool results: this service watches the loop's `onDidFinishStep` and enqueues
 * a `ContinuationStepRequest` whenever a step ends with `tool_calls` — which
 * is exactly when the step ran tools without a stopTurn tool result (the
 * loop maps that combination onto the `tool_calls` finish reason). The loop
 * itself only drains the queue and dispatches errors; it never enqueues. A
 * hook-set `stopTurn` still wins over the continuation: the turn ends at the
 * step boundary and the turn-scoped request is discarded by the run-end
 * cleanup. Bound at Agent scope; Eager so the hook registers before the
 * first turn runs (same rationale as `stepRetry`).
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IAgentLoopContinuationService } from './loopContinuation';
import { IAgentLoopService } from './loop';
import { ContinuationStepRequest } from './stepRequest';

export class AgentLoopContinuationService
  extends Disposable
  implements IAgentLoopContinuationService
{
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentLoopService loop: IAgentLoopService) {
    super();
    this._register(
      loop.hooks.onDidFinishStep.register('loop-continuation', async (ctx, next) => {
        await next();
        if (ctx.stopTurn || ctx.finishReason !== 'tool_calls') return;
        loop.enqueue(new ContinuationStepRequest());
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopContinuationService,
  AgentLoopContinuationService,
  InstantiationType.Eager,
  'loop',
);
