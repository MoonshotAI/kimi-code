/**
 * Recovery contract, attempt ledger, and requester-scoped memory: a recovery proposes a request rewrite
 * or side effect for a failed attempt; reusable rewrites can be restored by later requests on the same route.
 */
import type { LlmEndpoint, LlmProtocolRequest } from '#/llm/request';
import type { LlmErrorMessage } from '#/llm/response';

export interface LlmRecoveryRecord {
  readonly strategy: string;
  readonly action: string;
}

export interface LlmRecoveryContext {
  readonly error: LlmErrorMessage;
  readonly request: LlmProtocolRequest;
  readonly appliedRecoveries: readonly LlmRecoveryRecord[];
  readonly endpoint?: LlmEndpoint;
}

export type LlmRequestRewrite = (request: LlmProtocolRequest) => LlmProtocolRequest;

export interface LlmRecoveryProposal {
  readonly action: string;
  readonly rewrite?: LlmRequestRewrite;
  readonly beforeNextAttempt?: () => void;
}

export type LlmRecoveryEntry = LlmRecoveryProposal & LlmRecoveryRecord & {
  readonly reuse?: {
    readonly key: string;
  };
};

export interface LlmRecoveryMemory {
  read(request: LlmProtocolRequest): readonly LlmRecoveryEntry[];
  record(request: LlmProtocolRequest, entry: LlmRecoveryEntry): void;
  clear(): void;
}

export interface LlmRecovery {
  propose(ctx: LlmRecoveryContext): LlmRecoveryEntry | undefined;
}

export interface LlmRecoveryLedger {
  readonly applied: readonly LlmRecoveryRecord[];
  apply(request: LlmProtocolRequest): LlmProtocolRequest;
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

export function createRecoveryMemory(): LlmRecoveryMemory {
  const cached = new Map<string, readonly LlmRecoveryEntry[]>();
  const protocolIds = new WeakMap<object, number>();
  let nextProtocolId = 1;
  const routeKey = (request: LlmProtocolRequest): string => {
    const protocol = request.protocol;
    if (protocol.recoveryKey === undefined && !protocolIds.has(protocol.base)) {
      protocolIds.set(protocol.base, nextProtocolId++);
    }
    const protocolKey = protocol.recoveryKey ?? `object:${String(protocolIds.get(protocol.base))}`;
    const { spec } = request.model;
    return JSON.stringify([
      spec.provider,
      spec.name,
      request.endpoint?.baseUrl ?? request.endpoint?.defaultBaseUrl,
      spec.maxContextSize,
      spec.maxInputSize,
      spec.capability?.image_in,
      spec.capability?.video_in,
      spec.capability?.audio_in,
      protocolKey,
    ]);
  };
  return {
    clear: () => cached.clear(),
    read: (request) => (cached.get(routeKey(request)) ?? []).filter(
      (entry) => entry.rewrite !== undefined && entry.rewrite(request) !== request,
    ),
    record: (request, entry) => {
      if (entry.reuse === undefined || entry.rewrite === undefined) return;
      const key = routeKey(request);
      const next = (cached.get(key) ?? []).filter((current) => current.reuse?.key !== entry.reuse?.key);
      cached.set(key, [...next, entry].toSorted((left, right) =>
        left.strategy.localeCompare(right.strategy) ||
        left.action.localeCompare(right.action) ||
        (left.reuse?.key ?? '').localeCompare(right.reuse?.key ?? ''),
      ));
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
