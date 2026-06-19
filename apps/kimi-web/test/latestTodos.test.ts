// apps/kimi-web/test/latestTodos.test.ts
//
// The floating todo card shows the CURRENT list: every TodoList write carries
// the full list, [] clears it, and a call without `todos` is a read-only
// query. These tests pin that derivation from a real transcript shape.

import { describe, expect, it } from 'vitest';
import type { AppMessage } from '../src/api/types';
import { latestTodos } from '../src/composables/latestTodos';

let n = 0;
function assistantToolUse(toolName: string, input: unknown): AppMessage {
  n += 1;
  return {
    id: `msg_${n}`,
    sessionId: 'sess_1',
    role: 'assistant',
    content: [{ type: 'toolUse', toolCallId: `t${n}`, toolName, input }],
    createdAt: new Date().toISOString(),
  };
}

describe('latestTodos', () => {
  it('returns the newest full-list write', () => {
    const msgs = [
      assistantToolUse('TodoList', { todos: [{ title: '旧任务', status: 'pending' }] }),
      assistantToolUse('TodoList', {
        todos: [
          { title: '改投影层', status: 'done' },
          { title: '加卡片组件', status: 'in_progress' },
          { title: '补测试', status: 'pending' },
        ],
      }),
    ];
    expect(latestTodos(msgs)).toEqual([
      { title: '改投影层', status: 'done' },
      { title: '加卡片组件', status: 'in_progress' },
      { title: '补测试', status: 'pending' },
    ]);
  });

  it('ignores read-only queries (no todos field) and falls back to the last write', () => {
    const msgs = [
      assistantToolUse('TodoList', { todos: [{ title: 'A', status: 'pending' }] }),
      assistantToolUse('TodoList', {}),
    ];
    expect(latestTodos(msgs)).toEqual([{ title: 'A', status: 'pending' }]);
  });

  it('an empty-array write clears the list', () => {
    const msgs = [
      assistantToolUse('TodoList', { todos: [{ title: 'A', status: 'pending' }] }),
      assistantToolUse('TodoList', { todos: [] }),
    ];
    expect(latestTodos(msgs)).toEqual([]);
  });

  it('accepts alias tool names, string input and TodoWrite-style items', () => {
    const msgs = [
      assistantToolUse(
        'TodoWrite',
        JSON.stringify({ todos: [{ content: 'B', status: 'completed' }] }),
      ),
    ];
    expect(latestTodos(msgs)).toEqual([{ title: 'B', status: 'done' }]);
  });

  it('returns [] when no todo tool was ever called', () => {
    expect(latestTodos([assistantToolUse('bash', { command: 'ls' })])).toEqual([]);
  });
});
