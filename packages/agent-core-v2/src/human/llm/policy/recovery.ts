import type { LlmEndpoint, LlmRequest } from '#/llm/request';
import type { LlmRemoteErrorMessage } from '#/llm/response';

export interface LlmRecoveryRecord {
  readonly strategy: string;
  readonly action: string;
}

export interface LlmRecoveryContext {
  readonly error: LlmRemoteErrorMessage;
  readonly request: LlmRequest;
  readonly appliedRecoveries: readonly LlmRecoveryRecord[];
  readonly endpoint?: LlmEndpoint;
}

export type LlmRequestRewrite = (request: LlmRequest) => LlmRequest;

export interface LlmRecoveryProposal {
  readonly action: string;
  readonly rewrite?: LlmRequestRewrite;
  readonly beforeNextAttempt?: () => void;
}

export type LlmRecoveryEntry = LlmRecoveryProposal & LlmRecoveryRecord;

export interface LlmRecovery {
  propose(ctx: LlmRecoveryContext): LlmRecoveryEntry | undefined;
}

export interface LlmRecoveryLedger {
  readonly applied: readonly LlmRecoveryRecord[];
  apply(request: LlmRequest): LlmRequest;
  record(entry: LlmRecoveryEntry): void;
}

export function createRecoveryLedger(): LlmRecoveryLedger {
  const applied: LlmRecoveryRecord[] = [];
  const rewrites: LlmRequestRewrite[] = [];
  return {
    applied,
    apply: (request) => rewrites.reduce((current, rewrite) => rewrite(current), request),
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
    if (proposal.rewrite !== undefined && proposal.rewrite(ctx.request) === ctx.request) {
      continue;
    }
    return proposal;
  }
  return undefined;
}
