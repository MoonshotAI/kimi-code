import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
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
  /**
   * Client-managed session tool denylist (full-replace semantics), applied
   * before the prompt is enqueued. Omit to keep the current value; `[]`
   * clears the client portion.
   */
  readonly disabledTools?: readonly string[];
  /**
   * Client-chosen prompt record id, echoed on the consuming turn's
   * `turn.started` (`promptId`). A duplicate id rejects the submission before
   * any session state is touched.
   */
  readonly promptId?: string;
}

export interface SteerPayload {
  readonly input: readonly ContentPart[];
}

export interface PromptLaunchResult {
  readonly turn_id: number;
}

export interface PromptReservation extends IDisposable {
  readonly id: string;
  submit(message: ContextMessage): Promise<PromptHandle>;
}

export const promptAdmission = Symbol('promptAdmission');

type PromptAdmissionHook = (promptId?: string) => PromptReservation;

export function reservePrompt(service: IAgentPromptService, promptId?: string): PromptReservation {
  return (service as IAgentPromptService & { [promptAdmission]: PromptAdmissionHook })[
    promptAdmission
  ](promptId);
}

export interface IAgentPromptService {
  readonly _serviceBrand: undefined;
  enqueue(input: PromptInput): Promise<PromptHandle>;
  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined>;
  list(): PromptQueueSnapshot;
  steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]>;
  abort(promptId: string, reason?: Error): boolean;
  drain(reason?: Error): Promise<void>;
  inject(message: ContextMessage): Promise<Turn | undefined>;
  retry(): Promise<Turn | undefined>;
  clear(): void;
  readonly hooks: Hooks<{ onBeforeSubmitPrompt: PromptSubmitContext }>;
}

export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
