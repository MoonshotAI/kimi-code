/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2, type AgentDomainTrait } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { CompactionBeginData, CompactionResult, CompactionSource } from './types';

export type CompactionPhase = 'idle' | 'running' | 'cancelled' | 'completed';

export interface CompactionState {
  readonly phase: CompactionPhase;
}

const fullCompactionBeginSchema = z.object({
  agentId: z.string(),
  instruction: z.string().optional(),
  source: z.custom<CompactionSource>(),
});

export class FullCompactionBegin extends AgentEvent2<
  z.infer<typeof fullCompactionBeginSchema>
> {
  static override readonly type = 'full_compaction.begin';
  static override readonly durable = true;
  static override readonly schema = fullCompactionBeginSchema;
}
export interface FullCompactionBegin extends CompactionBeginData {
  readonly agentId: string;
}

const fullCompactionCancelSchema = z.object({ agentId: z.string() });

export class FullCompactionCancel extends AgentEvent2<
  z.infer<typeof fullCompactionCancelSchema>
> {
  static override readonly type = 'full_compaction.cancel';
  static override readonly durable = true;
  static override readonly schema = fullCompactionCancelSchema;
}
export interface FullCompactionCancel {
  readonly agentId: string;
}

const fullCompactionCompleteSchema = z.object({ agentId: z.string() });

export class FullCompactionComplete extends AgentEvent2<
  z.infer<typeof fullCompactionCompleteSchema>
> {
  static override readonly type = 'full_compaction.complete';
  static override readonly durable = true;
  static override readonly schema = fullCompactionCompleteSchema;
}
export interface FullCompactionComplete {
  readonly agentId: string;
}

export interface CompactionStartedPayload {
  readonly agentId: string;
  readonly trigger: CompactionSource;
  readonly instruction?: string;
}

export class CompactionStarted extends AgentEvent2<CompactionStartedPayload> {
  static override readonly type = 'compaction.started';
  static override readonly observable = true;
}
export interface CompactionStarted extends CompactionStartedPayload {}

export interface CompactionBlockedPayload {
  readonly agentId: string;
  readonly turnId?: number;
}

export class CompactionBlocked extends AgentEvent2<CompactionBlockedPayload> {
  static override readonly type = 'compaction.blocked';
  static override readonly observable = true;
}
export interface CompactionBlocked extends CompactionBlockedPayload {}

export class CompactionCancelled extends AgentEvent2<AgentDomainTrait> {
  static override readonly type = 'compaction.cancelled';
  static override readonly observable = true;
}
export interface CompactionCancelled {
  readonly agentId: string;
}

export interface CompactionCompletedPayload {
  readonly agentId: string;
  readonly result: CompactionResult;
}

export class CompactionCompleted extends AgentEvent2<CompactionCompletedPayload> {
  static override readonly type = 'compaction.completed';
  static override readonly observable = true;
}
export interface CompactionCompleted extends CompactionCompletedPayload {}

export const fullCompactionKey = defineState(
  'fullCompaction',
  (): CompactionState => ({ phase: 'idle' }),
).replayable({ schema: z.custom<CompactionState>() })
  .on(FullCompactionBegin, (s, e, ctx) => {
    if (s.phase !== 'running') {
      s.phase = 'running';
    }
    ctx.emit(
      new CompactionStarted({
        agentId: e.agentId,
        trigger: e.source,
        instruction: e.instruction,
      }),
    );
  })
  .on(FullCompactionCancel, (s) => {
    if (s.phase !== 'idle') {
      s.phase = 'idle';
    }
  })
  .on(FullCompactionComplete, (s) => {
    if (s.phase !== 'idle') {
      s.phase = 'idle';
    }
  });
