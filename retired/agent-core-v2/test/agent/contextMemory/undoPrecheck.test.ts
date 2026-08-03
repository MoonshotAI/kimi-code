import { describe, expect, it } from 'vitest';

import { precheckUndo } from '#/agent/contextMemory/contextOps';
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

describe('precheckUndo', () => {
  it('returns ok when enough real user prompts exist', () => {
    expect(precheckUndo([user(USER_ORIGIN), assistant()], 1)).toEqual({ ok: true });
  });

  it('skips trailing non-user messages while scanning', () => {
    expect(precheckUndo([user(USER_ORIGIN), assistant(), assistant()], 1)).toEqual({ ok: true });
  });

  it('treats a user message without origin as a real prompt (legacy)', () => {
    expect(precheckUndo([user(), assistant()], 1)).toEqual({ ok: true });
  });

  it('returns empty when the history has no real user prompt', () => {
    expect(precheckUndo([], 1)).toEqual({
      ok: false,
      reason: 'empty',
      requested: 1,
      undoable: 0,
    });
  });

  it('returns empty when only injections are present', () => {
    expect(precheckUndo([injection(), assistant()], 1)).toEqual({
      ok: false,
      reason: 'empty',
      requested: 1,
      undoable: 0,
    });
  });

  it('returns insufficient when some but fewer than count prompts exist', () => {
    const history = [user(USER_ORIGIN), assistant(), user(USER_ORIGIN), assistant()];
    expect(precheckUndo(history, 3)).toEqual({
      ok: false,
      reason: 'insufficient',
      requested: 3,
      undoable: 2,
    });
  });

  it('returns compaction_boundary when a summary is hit before count is met', () => {
    expect(precheckUndo([user(USER_ORIGIN), compaction(), assistant()], 1)).toEqual({
      ok: false,
      reason: 'compaction_boundary',
      requested: 1,
      undoable: 0,
    });
  });

  it('reports compaction_boundary over insufficient when the boundary stops the scan', () => {
    const history = [user(USER_ORIGIN), compaction(), user(USER_ORIGIN), assistant()];
    expect(precheckUndo(history, 2)).toEqual({
      ok: false,
      reason: 'compaction_boundary',
      requested: 2,
      undoable: 1,
    });
  });
});
