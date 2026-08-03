import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentStepRetryService {
  readonly _serviceBrand: undefined;
}

export const IAgentStepRetryService = createDecorator<IAgentStepRetryService>(
  'agentStepRetryService',
);
