/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { AgentEvent2, type AgentDomainTrait } from '#/app/event/event2';

import type { CompactionResult, CompactionSource } from './types';

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
