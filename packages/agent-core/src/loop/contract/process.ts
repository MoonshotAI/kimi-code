import type { HistoryMessage, UserEntry } from '#/history/message';
import type { LoopProfile } from './command';
import type { LoopEmitted } from './emitted';
import type { QueuedItem, TurnTrigger } from './inbox';
import type { TurnOutcome } from './outcome';

export interface TurnStart {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
  readonly pending: readonly QueuedItem[];
  readonly messages: readonly HistoryMessage[];
  readonly profile: LoopProfile;
  readonly resumed?: true;
}

export type LoopSignal =
  | ({ type: 'turn.start' } & TurnStart)
  | { type: 'turn.drained'; pending: readonly QueuedItem[] }
  | { type: 'context.set'; messages: readonly HistoryMessage[] }
  | { type: 'profile.set'; profile: LoopProfile }
  | { type: 'input.abort_turn'; reason?: unknown }
  | { type: 'input.abort_tool'; toolCallId: string; reason?: unknown }
  | { type: 'input.detach_tool'; toolCallId: string }
  | { type: 'input.close' };

export type ProcessFact =
  | { type: 'inbox.notify'; entries: readonly UserEntry[] }
  | { type: 'turn.draining' }
  | { type: 'turn.released'; pending: readonly QueuedItem[] }
  | { type: 'turn.finished'; outcome: TurnOutcome }
  | { type: 'ending.entered' }
  | { type: 'ending.exited' };

export type LoopFact = LoopEmitted | ProcessFact;
