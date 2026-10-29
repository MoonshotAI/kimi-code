import type { LlmEndpoint, LlmRequest } from '#/llm/request';
import type { LlmErrorMessage } from '#/llm/response';

export interface LlmRecoveryRecord {
  readonly strategy: string;
  readonly action: string;
}

export interface LlmRecoveryContext {
  readonly error: LlmErrorMessage;
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
  fork(filter?: (entry: LlmRecoveryEntry) => boolean): LlmRecoveryLedger;
  map(mapper: (entry: LlmRecoveryEntry) => LlmRecoveryEntry): LlmRecoveryLedger;
}

export function createRecoveryLedger(
  seed: readonly LlmRecoveryEntry[] = [],
): LlmRecoveryLedger {
  const entries = [...seed];
  const applied: LlmRecoveryRecord[] = entries.map(({ strategy, action }) => ({ strategy, action }));
  const rewrites = entries.flatMap(({ rewrite }) => (rewrite === undefined ? [] : [rewrite]));
  return {
    applied,
    apply: (request) => rewrites.reduce((current, rewrite) => rewrite(current), request),
    record: (entry) => {
      entries.push(entry);
      applied.push({ strategy: entry.strategy, action: entry.action });
      if (entry.rewrite !== undefined) rewrites.push(entry.rewrite);
    },
    fork: (filter) => createRecoveryLedger(filter === undefined ? entries : entries.filter(filter)),
    map: (mapper) => createRecoveryLedger(entries.map(mapper)),
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
