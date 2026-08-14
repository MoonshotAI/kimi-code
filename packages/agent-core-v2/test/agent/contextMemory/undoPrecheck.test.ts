import { describe, expect, it } from 'vitest';

import {
  computeUndoCut,
  computeUndoCutFrom,
  isFullyUndoable,
} from '#/agent/contextMemory/conversationTime';
import { contextUndo } from '#/agent/contextMemory/contextOps';
import {
  EMPTY_FOLD,
  type ContextMessage,
  type ContextState,
} from '#/agent/contextMemory/types';

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
    expect(cut).toEqual({ cutIndex: 0, anchorIndex: 0, removedCount: 1, stoppedAtCompaction: false });
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
    expect(cut).toEqual({ cutIndex: -1, anchorIndex: -1, removedCount: 0, stoppedAtCompaction: false });
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
    expect(cut).toEqual({ cutIndex: -1, anchorIndex: -1, removedCount: 0, stoppedAtCompaction: true });
    expect(isFullyUndoable(cut, 1)).toBe(false);
  });

  it('stops at a compaction summary even after counting some prompts', () => {
    const history = [user(USER_ORIGIN), compaction(), user(USER_ORIGIN), assistant()];
    const cut = computeUndoCut(history, 2);
    expect(cut.removedCount).toBe(1);
    expect(cut.stoppedAtCompaction).toBe(true);
    expect(isFullyUndoable(cut, 2)).toBe(false);
  });

  it('computeUndoCutFrom walks wrapped entries and stops at the given floor', () => {
    const entries = [user(USER_ORIGIN), user(USER_ORIGIN), assistant()].map((message) => ({
      message,
    }));
    const cut = computeUndoCutFrom(entries, 2, (entry) => entry.message, 1);
    expect(cut).toEqual({
      cutIndex: 1,
      anchorIndex: 1,
      removedCount: 1,
      stoppedAtCompaction: false,
    });
    expect(isFullyUndoable(cut, 2)).toBe(false);
  });
});

describe('contextUndo op', () => {
  function stateOf(messages: readonly ContextMessage[]): ContextState {
    return { messages, fold: EMPTY_FOLD };
  }

  it('slices the history at the cut point, dropping post-cut injections too', () => {
    const state = stateOf([
      user(USER_ORIGIN),
      assistant(),
      user(USER_ORIGIN),
      injection(),
      assistant(),
    ]);
    const next = contextUndo.apply(state, { count: 1 });
    expect(next.messages).toEqual([user(USER_ORIGIN), assistant()]);
    expect(next.fold).toBe(EMPTY_FOLD);
  });

  it('returns the same reference when not fully undoable', () => {
    const state = stateOf([user(USER_ORIGIN), compaction(), assistant()]);
    expect(contextUndo.apply(state, { count: 1 })).toBe(state);
  });

  it.each([0, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'returns the same reference for invalid count %s',
    (count) => {
      const state = stateOf([user(USER_ORIGIN), assistant()]);
      expect(contextUndo.apply(state, { count })).toBe(state);
    },
  );
});
