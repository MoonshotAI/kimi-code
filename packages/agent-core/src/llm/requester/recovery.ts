import type { LlmErrorMessage, LlmRemoteErrorMessage } from '#/llm/errors';
import type { Message } from '#/llm/message';

import type { LlmCredentialProvider } from './requester';

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

export type LlmRecovering = {
  readonly type: 'llm.recovering';
  readonly strategy: string;
  readonly action: string;
  readonly error: LlmErrorMessage;
};

export function proposeFirst(
  recoveries: readonly LlmRecovery[],
  ctx: LlmRecoveryContext,
): (LlmRecoveryProposal & LlmRecoveryRecord) | undefined {
  for (const recovery of recoveries) {
    const proposal = recovery.propose(ctx);
    if (proposal === undefined) continue;
    if (
      proposal.attemptMessageOverride !== undefined &&
      proposal.attemptMessageOverride === ctx.messages
    ) {
      continue;
    }
    return proposal;
  }
  return undefined;
}
