import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentExternalHooksService {
  readonly _serviceBrand: undefined;
}

export const IAgentExternalHooksService =
  createDecorator<IAgentExternalHooksService>('agentExternalHooksService');
