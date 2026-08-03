import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentLoopContinuationService {
  readonly _serviceBrand: undefined;
}

export const IAgentLoopContinuationService = createDecorator<IAgentLoopContinuationService>(
  'agentLoopContinuationService',
);
