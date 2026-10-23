import type { Message } from '#/llm/message';
import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { LlmEndpoint } from '#/llm/request';

export interface LlmRecoveryRecord {
  readonly strategy: string;
  readonly action: string;
}

export interface LlmRecoveryContext {
  readonly error: LlmRemoteErrorMessage;
  readonly messages: readonly Message[];
  readonly appliedRecoveries: readonly LlmRecoveryRecord[];
  readonly endpoint?: LlmEndpoint;
}

export type LlmMessageRewrite = (messages: readonly Message[]) => readonly Message[];

export interface LlmRecoveryProposal {
  readonly action: string;
  readonly rewrite?: LlmMessageRewrite;
  readonly beforeNextAttempt?: () => void;
}

export type LlmRecoveryEntry = LlmRecoveryProposal & LlmRecoveryRecord;

export interface LlmRecovery {
  propose(ctx: LlmRecoveryContext): LlmRecoveryEntry | undefined;
}

export interface LlmRecoveryLedger {
  readonly applied: readonly LlmRecoveryRecord[];
  apply(messages: readonly Message[]): readonly Message[];
  record(entry: LlmRecoveryEntry): void;
}

export function createRecoveryLedger(): LlmRecoveryLedger {
  const applied: LlmRecoveryRecord[] = [];
  const rewrites: LlmMessageRewrite[] = [];
  return {
    applied,
    apply: (messages) => rewrites.reduce((current, rewrite) => rewrite(current), messages),
    record: ({ strategy, action, rewrite }) => {
      applied.push({ strategy, action });
      if (rewrite !== undefined) rewrites.push(rewrite);
    },
  };
}

export function proposeFirst(
  recoveries: readonly LlmRecovery[],
  ctx: LlmRecoveryContext,
): LlmRecoveryEntry | undefined {
  for (const recovery of recoveries) {
    const proposal = recovery.propose(ctx);
    if (proposal === undefined) continue;
    if (proposal.rewrite !== undefined && proposal.rewrite(ctx.messages) === ctx.messages) {
      continue;
    }
    return proposal;
  }
  return undefined;
}
