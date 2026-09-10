import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { Message } from '#/llm/message';
import type { LlmCredentialProvider } from '#/llm/requester/requester';

export interface LlmRecoveryRecord {
  readonly strategy: string;
  readonly action: string;
}

export interface LlmRecoveryContext {
  readonly error: LlmRemoteErrorMessage;
  readonly messages: readonly Message[];
  readonly applied: readonly LlmRecoveryRecord[];
  readonly credentials?: LlmCredentialProvider;
}

export interface LlmRecoveryProposal {
  readonly action: string;
  readonly messages?: readonly Message[];
  readonly refreshCredentials?: boolean;
}

export interface LlmRecovery {
  readonly id: string;
  propose(ctx: LlmRecoveryContext): LlmRecoveryProposal | undefined;
}
