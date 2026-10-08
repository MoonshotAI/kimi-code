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
  readonly appliedRecoveries: readonly LlmRecoveryRecord[];
  readonly credentialProvider?: LlmCredentialProvider;
}

export interface LlmRecoveryProposal {
  readonly action: string;
  readonly attemptMessageOverride?: readonly Message[];
  readonly beforeNextAttempt?: () => void;
}

export interface LlmRecovery {
  propose(ctx: LlmRecoveryContext): (LlmRecoveryProposal & LlmRecoveryRecord) | undefined;
}
