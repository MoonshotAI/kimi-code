import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { Message } from '#/llm/message';

export interface LlmRecoveryRecord {
  readonly strategy: string;
  readonly action: string;
}

export interface LlmRecoveryContext {
  readonly error: LlmRemoteErrorMessage;
  readonly messages: readonly Message[];
  readonly applied: readonly LlmRecoveryRecord[];
}

export interface LlmRecoveryProposal {
  readonly action: string;
  readonly messages: readonly Message[];
}

export interface LlmRecovery {
  readonly id: string;
  propose(ctx: LlmRecoveryContext): LlmRecoveryProposal | undefined;
}
