import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent } from '../src/api/types';
import { latestTodos } from '../src/composables/latestTodos';
import { messagesToTurns } from '../src/composables/messagesToTurns';

function message(
  id: string,
  role: AppMessage['role'],
  content: AppMessageContent[],
  extra: Partial<AppMessage> = {},
): AppMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('messagesToTurns', () => {
  it('merges an assistant turn and folds tool results into it', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hello' }]),
        message('a1', 'assistant', [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'read', input: { path: 'src/a.ts' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'alpha\nbeta' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'done' }]),
      ],
      [],
      undefined,
      false,
      [],
    );

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      thinking: 'plan',
      text: 'done',
    });
    expect(turns[1]?.tools).toMatchObject([
      { id: 'tool-1', status: 'ok', output: ['alpha', 'beta'] },
    ]);
  });

  it('splits assistant turns when prompt ids differ', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }], { promptId: 'p1' }),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }], { promptId: 'p2' }),
      ],
      [],
      undefined,
      false,
      [],
    );

    expect(turns.map((turn) => turn.text)).toEqual(['one', 'two']);
  });

  it('renders compaction summaries as divider turns', () => {
    const turns = messagesToTurns(
      [
        message('s1', 'assistant', [{ type: 'text', text: 'summary' }], {
          metadata: { origin: { kind: 'compaction_summary' } },
        }),
      ],
      [],
      undefined,
      false,
      [],
    );

    expect(turns).toMatchObject([{ role: 'compaction', text: 'summary' }]);
  });
});

describe('latestTodos', () => {
  it('returns the newest todo write and ignores later read-only queries', () => {
    expect(
      latestTodos([
        message('a1', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'todo-1',
            toolName: 'TodoWrite',
            input: { todos: [{ title: 'old', status: 'pending' }] },
          },
        ]),
        message('a2', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'todo-2',
            toolName: 'TodoWrite',
            input: JSON.stringify({ todos: [{ content: 'new', status: 'completed' }] }),
          },
        ]),
        message('a3', 'assistant', [
          { type: 'toolUse', toolCallId: 'todo-3', toolName: 'TodoRead', input: {} },
        ]),
      ]),
    ).toEqual([{ title: 'new', status: 'done' }]);
  });
});
