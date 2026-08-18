import { createDecorator } from '#/_base/di/instantiation';

export interface RenderedExternalHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
}

export interface IAgentExternalHooksService {
  readonly _serviceBrand: undefined;
}

export const IAgentExternalHooksService =
  createDecorator<IAgentExternalHooksService>('agentExternalHooksService');
