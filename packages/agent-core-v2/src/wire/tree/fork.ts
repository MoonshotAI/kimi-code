import { isPromptOwnedInjection, isUndoAnchor } from '#/agent/contextMemory/conversationTime';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { WireRecord } from '#/wire/record';

import { AGENT_SWITCHED_TYPE, type WireLine } from './tree';

export type ForkLineFailure = 'compaction_boundary' | 'insufficient';

export class ForkLineError extends Error {
  constructor(readonly reason: ForkLineFailure) {
    super(reason);
    this.name = 'ForkLineError';
  }
}

const compactionSummaryMarker: ContextMessage = {
  role: 'user',
  content: [],
  toolCalls: [],
  origin: { kind: 'compaction_summary' },
};

function isContextMessage(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object') return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

export function computeForkLine(chain: readonly WireLine[], turns: number): number {
  let clearFloor = 0;
  for (const { record, line } of chain) {
    if (record.type === 'context.clear') clearFloor = line;
  }
  const messages: { readonly message: ContextMessage; readonly line: number }[] = [];
  for (const { record, line } of chain) {
    if (line <= clearFloor) continue;
    if (record.type === 'context.append_message') {
      const message = record['message'];
      if (isContextMessage(message)) messages.push({ message, line });
    } else if (record.type === 'context.apply_compaction') {
      messages.push({ message: compactionSummaryMarker, line });
    }
  }
  let remaining = turns;
  let cutIndex = -1;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const { message } = messages[index]!;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') throw new ForkLineError('compaction_boundary');
    if (isUndoAnchor(message)) {
      remaining--;
      cutIndex = index;
      while (cutIndex > 0 && isPromptOwnedInjection(messages[cutIndex - 1]!.message, message)) {
        cutIndex--;
      }
    }
  }
  if (cutIndex < 0 || remaining > 0) throw new ForkLineError('insufficient');
  return messages[cutIndex]!.line - 1;
}

export interface UndoSwitchRecords {
  readonly switched: WireRecord;
  readonly legacyUndo: WireRecord;
  readonly undone: WireRecord;
}

export function buildUndoSwitchRecords(input: {
  readonly agentId: string;
  readonly branch: string;
  readonly reason: string;
  readonly base: { readonly branch: string; readonly line: number };
  readonly turns: number;
  readonly edgeLine: number;
  readonly fromTurnId?: number;
  readonly time: number;
}): UndoSwitchRecords {
  const { agentId, branch, reason, base, turns, edgeLine, fromTurnId, time } = input;
  return {
    switched: {
      type: AGENT_SWITCHED_TYPE,
      agentId,
      branch,
      reason,
      base,
      turns,
      legacyUndoLine: edgeLine + 1,
      time,
    },
    legacyUndo: { type: 'context.undo', agentId, count: turns, time },
    undone: { type: 'context.undone', agentId, turns, fromTurnId, time },
  };
}
