/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

import type { CompactionBeginData, CompactionSource } from './types';

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
