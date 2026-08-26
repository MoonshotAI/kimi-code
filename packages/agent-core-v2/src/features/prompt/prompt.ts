import type { IDisposable } from '#/_base/di/lifecycle';
import type { ContextMessage } from '#/features/contextMemory/types';
import type { Turn, TurnResult } from '#/features/loop/internal/loop';
import type { ContentPart } from '#/kosong/contract/message';

export type PromptOrigin = {
  readonly kind: 'user' | 'skill' | 'system';
  readonly sourceId?: string;
};

export type PromptAdmission = 'newTurn' | 'currentTurn';

export interface PromptSubmitInput {
  readonly content: readonly ContentPart[];
  readonly origin: PromptOrigin;
  readonly admission?: PromptAdmission;
  readonly promptId?: string;
  readonly disabledTools?: readonly string[];
}

export interface PromptSubmitResult {
  readonly promptId: string;
  readonly createdAt: string;
  readonly state: 'queued' | 'running' | 'blocked';
  readonly turnId?: number;
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

export interface PromptSubmitContext {
  readonly promptMessage: ContextMessage;
  readonly isSteer: boolean;
  block: boolean;
}

export type PromptBeforeSubmitHook = (
  context: PromptSubmitContext,
  next: (context?: PromptSubmitContext) => Promise<void>,
) => void | Promise<void>;

export interface PromptAdmissionReservation extends IDisposable {
  readonly id: string;
}

export interface PromptRuntime {
  submit(input: PromptSubmitInput): Promise<PromptSubmitResult>;
  reserveAdmission(promptId?: string): PromptAdmissionReservation;
  submitMessage(message: ContextMessage): Promise<PromptHandle>;
  enqueue(input: PromptInput): Promise<PromptHandle>;
  list(): PromptQueueSnapshot;
  steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]>;
  abort(promptId: string, reason?: Error): boolean;
  drain(reason?: Error): Promise<void>;
  inject(message: ContextMessage): Promise<Turn | undefined>;
  retry(): Promise<Turn | undefined>;
  clear(): void;
  registerBeforeSubmitHook(name: string, hook: PromptBeforeSubmitHook): IDisposable;
}
