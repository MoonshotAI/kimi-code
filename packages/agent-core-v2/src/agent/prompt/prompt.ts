import { createDecorator } from "#/_base/di";
import type { ContextMessage } from "#/agent/contextMemory";
import type { Turn } from "#/agent/turn";
import type { Hooks } from '#/hooks';

export interface PromptSubmitContext {
  readonly promptMessage: ContextMessage;
  readonly isSteer: boolean;
  block: boolean;
}

export interface PromptSteerHandle {
  removeFromQueue(): void;
  readonly launched: Promise<Turn | undefined>;
}

export interface IAgentPromptService {
  readonly _serviceBrand: undefined;

  prompt(message: ContextMessage): Promise<Turn | undefined>;
  steer(message: ContextMessage): PromptSteerHandle;
  retry(trigger?: string): Turn | undefined;
  undo(count: number): number;
  clear(): void;

  readonly hooks: Hooks<{
    onWillSubmitPrompt: PromptSubmitContext;
  }>;
}

export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
