/**
 * `fullCompaction` domain (L4) — wire Model (`CompactionModel`) and the
 * `full_compaction.begin` (`fullCompactionBegin`) / `full_compaction.cancel`
 * (`fullCompactionCancel`) / `full_compaction.complete`
 * (`fullCompactionComplete`) Ops that mirror the full-compaction lifecycle into
 * a persisted, replayable phase, plus the `compaction.*` edge events
 * (`started` / `blocked` / `cancelled` / `completed`) declared on `DomainEventMap`
 * (`compaction.started` is derived from the `full_compaction.begin` Op's
 * `toEvent`; the rest publish directly from the service).
 *
 * The Model is intentionally phase-only — `{ phase }` (initial `idle`). The
 * richer per-compaction data (`instruction`, `compactedCount`, `tokensBefore`,
 * `tokensAfter`) is NOT resume state: `instruction` is only needed by the live
 * worker (which does not survive a restart) and by telemetry, so it rides the
 * `begin` payload (and is persisted on the record for audit) but is not stored
 * in the Model; the result numbers are consumed live by the
 * `compaction.completed` signal and their durable effect (the summary message)
 * already lives in `contextMemory`. The live `complete` payload is empty; legacy
 * logs may still carry result numbers, and `apply` accepts and ignores them while
 * collapsing to `idle`. Each `apply` returns
 * the same reference on a no-op so the wire's reference-equality gate stays
 * quiet; it carries no non-determinism.
 *
 * The runtime orchestration — `ActiveCompaction`, its `AbortController`, and
 * the in-flight worker promise — stays OUT of the Model (live-only service
 * members): none of it can be resumed, and a session never restores mid-flight.
 * A `running` phase stranded by a crash is reset to `idle` by the service's
 * `wire.onRestored` handler (mirroring `goal`'s post-replay normalization).
 *
 * The `compaction.*` events publish to `IEventBus` (`compaction.started` via the
 * `begin` Op's `toEvent`; the rest directly) and also emit live through
 * `wire.signal` (legacy channel, until Phase 3); they are declared here via
 * interface-merge (`error` is already declared by `mcp`, so it is not
 * re-declared). The `full_compaction.*` record shapes stay declared in
 * `WireRecordMap` (see `fullCompactionService.ts`) because the records still
 * ride the per-agent `wire.jsonl` log read by `wireRecord.restore()` /
 * `getRecords()` — `microCompaction` registers a `full_compaction.complete`
 * resumer against that stream. Consumed by the Agent-scope `fullCompactionService`.
 */

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';
import type {
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
} from '@moonshot-ai/protocol';

import type { CompactionBeginData, CompactionSource, FullCompactionCompleteData } from './types';

export type CompactionPhase = 'idle' | 'running' | 'cancelled' | 'completed';

export interface CompactionState {
  readonly phase: CompactionPhase;
}

export const CompactionModel = defineModel<CompactionState>('fullCompaction', () => ({
  phase: 'idle',
}));

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'compaction.started': CompactionStartedEvent;
    'compaction.blocked': CompactionBlockedEvent;
    'compaction.cancelled': CompactionCancelledEvent;
    'compaction.completed': CompactionCompletedEvent & { readonly trigger: CompactionSource };
  }
}

export type FullCompactionBeginPayload = CompactionBeginData;

export const fullCompactionBegin = defineOp(CompactionModel, 'full_compaction.begin', {
  apply: (s, _p: FullCompactionBeginPayload): CompactionState =>
    s.phase === 'running' ? s : { phase: 'running' },
  toEvent: (p) => ({
    type: 'compaction.started' as const,
    trigger: p.source,
    instruction: p.instruction,
  }),
});

export const fullCompactionCancel = defineOp(CompactionModel, 'full_compaction.cancel', {
  apply: (s): CompactionState => (s.phase === 'idle' ? s : { phase: 'idle' }),
});

export type FullCompactionCompletePayload = Partial<FullCompactionCompleteData>;

export const fullCompactionComplete = defineOp(CompactionModel, 'full_compaction.complete', {
  apply: (s, _p: FullCompactionCompletePayload): CompactionState =>
    s.phase === 'idle' ? s : { phase: 'idle' },
});
