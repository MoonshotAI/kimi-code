import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Turn, TurnResult } from '#/agent/loop/loop';
import type { Hooks } from '#/hooks';

export interface PromptSubmitContext {
  readonly promptMessage: ContextMessage;
  readonly isSteer: boolean;
  block: boolean;
}

export interface PromptInput {
  readonly id?: string;
  readonly message: ContextMessage;
}

export type PromptState =
  | 'pending'
  | 'running'
  | 'steered'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface PromptCompletion {
  readonly promptId: string;
  readonly result: TurnResult | undefined;
  readonly state: Extract<PromptState, 'completed' | 'failed' | 'cancelled' | 'blocked'>;
}

export interface PromptSnapshot {
  readonly id: string;
  readonly userMessageId: string;
  readonly createdAt: string;
  readonly state: PromptState;
  readonly message: ContextMessage;
}

export interface PromptHandle extends PromptSnapshot {
  readonly launched: Promise<Turn | undefined>;
  readonly completion: Promise<PromptCompletion>;
}

export interface PromptQueueSnapshot {
  readonly active: PromptSnapshot | undefined;
  readonly pending: readonly PromptSnapshot[];
}

export interface IAgentPromptService {
  readonly _serviceBrand: undefined;
  enqueue(input: PromptInput): Promise<PromptHandle>;
  list(): PromptQueueSnapshot;
  steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]>;
  abort(promptId: string, reason?: Error): boolean;
  inject(message: ContextMessage): Promise<Turn | undefined>;
  retry(): Promise<Turn | undefined>;
  clear(): void;
  /**
   * Suspend launching queued prompts until the returned handle is disposed
   * (launching resumes, draining the queue, on the last release). The rewind
   * pipeline holds this across its quiesce→cut window so an aborted active
   * turn cannot auto-start the next queued prompt mid-rewind. Pending prompts
   * stay queued.
   */
  pauseLaunching(): IDisposable;
  readonly hooks: Hooks<{ onBeforeSubmitPrompt: PromptSubmitContext }>;
}

export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
