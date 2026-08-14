import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Turn, TurnResult } from '#/agent/loop/loop';
import type { ContentPart } from '#/kosong/contract/message';
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

export interface PromptPayload {
  readonly input: readonly ContentPart[];
}

export interface SteerPayload {
  readonly input: readonly ContentPart[];
}

export interface PromptLaunchResult {
  readonly turn_id: number;
}

export interface IAgentPromptService {
  readonly _serviceBrand: undefined;
  enqueue(input: PromptInput): Promise<PromptHandle>;
  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined>;
  list(): PromptQueueSnapshot;
  steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]>;
  abort(promptId: string, reason?: Error): boolean;
  inject(message: ContextMessage): Promise<Turn | undefined>;
  retry(): Promise<Turn | undefined>;
  clear(): void;
  readonly hooks: Hooks<{ onBeforeSubmitPrompt: PromptSubmitContext }>;
}

export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
