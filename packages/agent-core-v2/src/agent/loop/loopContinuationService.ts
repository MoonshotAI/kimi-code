import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { IAgentLoopContinuationService } from './loopContinuation';
import { IAgentLoopService } from './loop';
import { ContinuationStepRequest } from './stepRequest';

export class AgentLoopContinuationService
  extends Service
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
  ScopeActivation.OnScopeCreated,
  'loop',
);
