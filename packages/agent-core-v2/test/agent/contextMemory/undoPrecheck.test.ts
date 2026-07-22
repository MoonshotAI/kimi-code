import { describe, expect, it } from 'vitest';

import {
  computeUndoCut,
  contextUndo,
  isFullyUndoable,
} from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';

function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

function user(origin?: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [text('u')],
    toolCalls: [],
    ...(origin === undefined ? {} : { origin }),
  };
}

function assistant(): ContextMessage {
  return { role: 'assistant', content: [text('a')], toolCalls: [] };
}

function injection(): ContextMessage {
  return {
    role: 'user',
    content: [text('i')],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'system_reminder' },
  };
}

function compaction(): ContextMessage {
  return {
    role: 'user',
    content: [text('sum')],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

const USER_ORIGIN: ContextMessage['origin'] = { kind: 'user' };

describe('computeUndoCut', () => {
  it('finds the cut for the last real user prompt', () => {
    const cut = computeUndoCut([user(USER_ORIGIN), assistant()], 1);
    expect(cut).toEqual({ cutIndex: 0, removedCount: 1, stoppedAtCompaction: false });
    expect(isFullyUndoable(cut, 1)).toBe(true);
  });

  it('skips trailing non-user messages while scanning', () => {
    const cut = computeUndoCut([user(USER_ORIGIN), assistant(), assistant()], 1);
    expect(cut.cutIndex).toBe(0);
    expect(isFullyUndoable(cut, 1)).toBe(true);
  });

  it('treats a user message without origin as a real prompt (legacy)', () => {
    const cut = computeUndoCut([user(), assistant()], 1);
    expect(cut.cutIndex).toBe(0);
    expect(isFullyUndoable(cut, 1)).toBe(true);
  });

  it('finds nothing when the history has no real user prompt', () => {
    const cut = computeUndoCut([], 1);
    expect(cut).toEqual({ cutIndex: -1, removedCount: 0, stoppedAtCompaction: false });
    expect(isFullyUndoable(cut, 1)).toBe(false);
  });

  it('skips injections without counting them', () => {
    const cut = computeUndoCut([injection(), assistant()], 1);
    expect(cut.cutIndex).toBe(-1);
    expect(isFullyUndoable(cut, 1)).toBe(false);
  });

  it('counts fewer prompts than requested as not fully undoable', () => {
    const history = [user(USER_ORIGIN), assistant(), user(USER_ORIGIN), assistant()];
    const cut = computeUndoCut(history, 3);
    expect(cut.removedCount).toBe(2);
    expect(isFullyUndoable(cut, 3)).toBe(false);
  });

  it('stops at a compaction summary', () => {
    const cut = computeUndoCut([user(USER_ORIGIN), compaction(), assistant()], 1);
    expect(cut).toEqual({ cutIndex: -1, removedCount: 0, stoppedAtCompaction: true });
    expect(isFullyUndoable(cut, 1)).toBe(false);
  });

  it('stops at a compaction summary even after counting some prompts', () => {
    const history = [user(USER_ORIGIN), compaction(), user(USER_ORIGIN), assistant()];
    const cut = computeUndoCut(history, 2);
    expect(cut.removedCount).toBe(1);
    expect(cut.stoppedAtCompaction).toBe(true);
    expect(isFullyUndoable(cut, 2)).toBe(false);
  });
});

describe('contextUndo op', () => {
  it('slices the history at the cut point, dropping post-cut injections too', () => {
    const state = [
      user(USER_ORIGIN),
      assistant(),
      user(USER_ORIGIN),
      injection(),
      assistant(),
    ];
    const next = contextUndo.apply(state, { count: 1 });
    expect(next).toEqual([user(USER_ORIGIN), assistant()]);
  });

  it('returns the same reference when not fully undoable', () => {
    const state = [user(USER_ORIGIN), compaction(), assistant()];
    expect(contextUndo.apply(state, { count: 1 })).toBe(state);
  });

  it('returns the same reference for a non-positive count', () => {
    const state = [user(USER_ORIGIN), assistant()];
    expect(contextUndo.apply(state, { count: 0 })).toBe(state);
  });
});
