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
 * richer per-compaction data is NOT resume state: `instruction` is only needed
 * by the live worker (which does not survive a restart) and by telemetry, so it
 * rides the `begin` payload (and is persisted on the record for audit) but is
 * not stored in the Model; result numbers are consumed live by the
 * `compaction.completed` signal and their durable effect (the summary message
 * plus compaction metrics) already lives in `contextMemory`. The live
 * `complete` payload is empty to match the v1 wire shape; legacy logs may still
 * carry result numbers, and `apply` accepts and ignores them while collapsing
 * to `idle`. Each `apply` returns the same reference on a no-op so the wire's
 * reference-equality gate stays quiet; it carries no non-determinism.
 *
 * The runtime orchestration — `ActiveCompaction`, its `AbortController`, and
 * the in-flight worker promise — stays OUT of the Model (live-only service
 * members): none of it can be resumed, and a session never restores mid-flight.
 * A `running` phase stranded by a crash is reset to `idle` by the service's
 * `wire.hooks.onDidRestore` hook (mirroring `goal`'s post-replay normalization).
 *
 * The `compaction.*` events publish to `IEventBus` (`compaction.started` via the
 * `begin` Op's `toEvent`; the rest directly from the service); they are
 * declared here via interface-merge (`error` is already declared by `mcp`, so
 * it is not re-declared). The `full_compaction.*` record shapes are registered in
 * `PersistedOpMap` (`#/wire/types`, below) because the records still
 * ride the per-agent `wire.jsonl` journal restored by `IWireService`.
 * Consumed by the Agent-scope `fullCompactionService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { CompactionBeginData, CompactionResult } from './types';

export interface CompactionStartedEvent {
  readonly type: 'compaction.started';
  readonly trigger: 'manual' | 'auto';
  readonly instruction?: string;
}

export interface CompactionBlockedEvent {
  readonly type: 'compaction.blocked';
  readonly turnId?: number;
}

export interface CompactionCancelledEvent {
  readonly type: 'compaction.cancelled';
}

export interface CompactionCompletedEvent {
  readonly type: 'compaction.completed';
  readonly result: CompactionResult;
}

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
    'compaction.completed': CompactionCompletedEvent;
  }
}

declare module '#/wire/types' {
  interface PersistedOpMap {
    'full_compaction.begin': typeof fullCompactionBegin;
    'full_compaction.cancel': typeof fullCompactionCancel;
    'full_compaction.complete': typeof fullCompactionComplete;
  }
}

export const fullCompactionBegin = CompactionModel.defineOp('full_compaction.begin', {
  schema: z.custom<CompactionBeginData>(),
  apply: (s) => (s.phase === 'running' ? s : { phase: 'running' }),
  toEvent: (p) => ({
    type: 'compaction.started' as const,
    trigger: p.source,
    instruction: p.instruction,
  }),
});

export const fullCompactionCancel = CompactionModel.defineOp('full_compaction.cancel', {
  schema: z.object({}),
  apply: (s) => (s.phase === 'idle' ? s : { phase: 'idle' }),
});

export const fullCompactionComplete = CompactionModel.defineOp('full_compaction.complete', {
  schema: z.object({}),
  apply: (s) => (s.phase === 'idle' ? s : { phase: 'idle' }),
});
