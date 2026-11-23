import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentExternalHooksService {
  readonly _serviceBrand: undefined;
  drainStopHooks(): Promise<void>;
}

export const IAgentExternalHooksService =
  createDecorator<IAgentExternalHooksService>('agentExternalHooksService');
