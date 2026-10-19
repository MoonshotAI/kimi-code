import {
  isPromptOwnedInjection,
  isUndoAnchor,
  isValidUndoCount,
} from '#/agent/contextMemory/conversationTime';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { WireRecord } from '#/wire/record';

import { activeChain, AGENT_SWITCHED_TYPE, parseTree, type WireLine, type WireTree } from './tree';

export type ForkLineFailure = 'compaction_boundary' | 'insufficient';

export class ForkLineError extends Error {
  constructor(
    readonly reason: ForkLineFailure,
    readonly available: number,
  ) {
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

interface NumberedMessage {
  readonly message: ContextMessage;
  readonly line: number;
}

function foldUnpairedUndo(messages: NumberedMessage[], count: number): void {
  let removed = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const { message } = messages[index]!;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') return;
    if (!isUndoAnchor(message)) continue;
    removed++;
    if (removed < count) continue;
    let cutIndex = index;
    while (cutIndex > 0 && isPromptOwnedInjection(messages[cutIndex - 1]!.message, message)) {
      cutIndex--;
    }
    messages.splice(cutIndex);
    return;
  }
}

export function computeForkLine(
  chain: readonly WireLine[],
  pairedLegacyUndoLines: ReadonlySet<number>,
  turns: number,
): number {
  let clearFloor = 0;
  for (const { record, line } of chain) {
    if (record.type === 'context.clear') clearFloor = line;
  }
  const messages: NumberedMessage[] = [];
  for (const { record, line } of chain) {
    if (line <= clearFloor) continue;
    if (record.type === 'context.append_message') {
      const message = record['message'];
      if (isContextMessage(message)) messages.push({ message, line });
    } else if (record.type === 'context.apply_compaction') {
      messages.push({ message: compactionSummaryMarker, line });
    } else if (record.type === 'context.undo' && !pairedLegacyUndoLines.has(line)) {
      const count = record['count'];
      if (typeof count === 'number' && isValidUndoCount(count)) foldUnpairedUndo(messages, count);
    }
  }
  let remaining = turns;
  let cutIndex = -1;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const { message } = messages[index]!;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') {
      throw new ForkLineError('compaction_boundary', turns - remaining);
    }
    if (isUndoAnchor(message)) {
      remaining--;
      cutIndex = index;
      while (cutIndex > 0 && isPromptOwnedInjection(messages[cutIndex - 1]!.message, message)) {
        cutIndex--;
      }
    }
  }
  if (cutIndex < 0 || remaining > 0) {
    throw new ForkLineError('insufficient', turns - remaining);
  }
  return messages[cutIndex]!.line - 1;
}

export function restorableChain(
  entries: readonly WireLine[],
  tree: WireTree,
): WireLine[] {
  const chain = activeChain(entries, tree).filter(({ record, line }) => {
    if (record.type === 'context.undone') return false;
    if (record.type === 'context.undo' && tree.pairedLegacyUndoLines.has(line)) return false;
    return true;
  });
  const chainLines = new Set(chain.map((entry) => entry.line));
  const survivingPromptIds = new Set<string>();
  for (const { record } of chain) {
    if (record.type !== 'context.append_message') continue;
    const message = record['message'];
    if (!isContextMessage(message) || message.id === undefined) continue;
    if (isUndoAnchor(message)) survivingPromptIds.add(message.id);
  }
  const reIncluded: WireLine[] = [];
  for (const entry of entries) {
    if (chainLines.has(entry.line)) continue;
    if (entry.record.type !== 'context.append_message') continue;
    const message = entry.record['message'];
    if (!isContextMessage(message)) continue;
    const origin = message.origin;
    if (origin?.kind !== 'injection') continue;
    if (origin.ownerPromptId === undefined || survivingPromptIds.has(origin.ownerPromptId)) {
      reIncluded.push(entry);
    }
  }
  return [...chain, ...reIncluded].toSorted((a, b) => a.line - b.line);
}

export function flattenChain(records: readonly WireRecord[]): WireRecord[] {
  const entries: WireLine[] = records.map((record, index) => ({ record, line: index + 1 }));
  return restorableChain(entries, parseTree(entries, entries.length)).map(({ record }) => record);
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
