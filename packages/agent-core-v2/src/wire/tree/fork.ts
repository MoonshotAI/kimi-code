import { cutTurnUndo } from '#/agent/undo/turnUndo';
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

function isContextMessage(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object') return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

export function computeForkLine(
  chain: readonly WireLine[],
  pairedLegacyUndoLines: ReadonlySet<number>,
  turns: number,
): number {
  const result = cutTurnUndo(chain, pairedLegacyUndoLines, turns);
  if (result.cut !== undefined) return result.cut.line;
  if (result.stoppedAtCompaction) {
    throw new ForkLineError('compaction_boundary', result.anchors.length);
  }
  throw new ForkLineError('insufficient', result.anchors.length);
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
    if (record.type !== 'turn.prompt') continue;
    const promptId = record['promptId'];
    if (typeof promptId === 'string') survivingPromptIds.add(promptId);
  }
  const reIncluded: WireLine[] = [];
  for (const entry of entries) {
    if (chainLines.has(entry.line)) continue;
    if (entry.record.type === 'turn.prompt') {
      reIncluded.push(entry);
      continue;
    }
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
