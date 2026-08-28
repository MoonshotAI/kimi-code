import { Disposable } from '#/_base/di/lifecycle';

import type { LoopControl } from './loop';
import { ContinuationStepRequest } from './stepRequest';

export class AgentLoopContinuation extends Disposable {
  constructor(loop: LoopControl) {
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
