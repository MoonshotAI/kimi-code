import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import {
  IAgentLoopService,
  type PromptLaunchResult,
  type PromptPayload,
  type SteerPayload,
} from './loop';

export interface IAgentPromptChannel {
  readonly _serviceBrand: undefined;
  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined>;
}

export const IAgentPromptChannel = createDecorator<IAgentPromptChannel>('agentPromptService');

export class AgentPromptChannel implements IAgentPromptChannel {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentLoopService private readonly loop: IAgentLoopService) {}

  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    return this.loop.submitPrompt(payload);
  }

  submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined> {
    return this.loop.submitSteerPrompt(payload);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptChannel,
  AgentPromptChannel,
  ScopeActivation.OnDemand,
  'prompt',
);
