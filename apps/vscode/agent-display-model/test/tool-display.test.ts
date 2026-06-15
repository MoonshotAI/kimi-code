import { describe, expect, it } from 'vitest';

import {
  extractDisplayTodoItems,
  getRichToolDisplayBlocks,
  getTodoItemsForToolCall,
  getToolCallSummary,
  isTaskToolName,
  isTodoToolName,
  parseToolArguments,
} from '../src';

describe('tool display helpers', () => {
  it('parses tool arguments and creates stable tool summaries', () => {
    expect(parseToolArguments('{"command":"pnpm test"}')).toEqual({ command: 'pnpm test' });
    expect(parseToolArguments('not-json')).toEqual({ raw: 'not-json' });
    expect(getToolCallSummary('Shell', '{"command":"pnpm test"}')).toBe('pnpm test');
    expect(getToolCallSummary('ReadFile', '{"path":"/repo/src/file.ts"}')).toBe('file.ts');
    expect(getToolCallSummary('CustomTool', '{"query":"needle"}')).toBe('needle');
  });

  it('classifies task and todo tool names', () => {
    expect(isTaskToolName('Task')).toBe(true);
    expect(isTaskToolName('Agent')).toBe(true);
    expect(isTodoToolName('SetTodoList')).toBe(true);
    expect(isTodoToolName('Update Todos')).toBe(true);
    expect(getToolCallSummary('Update-Todos', '{}')).toBe('Update Todos');
  });

  it('extracts todo items from markdown and wrapped JSON', () => {
    expect(extractDisplayTodoItems('- [done] Done item\n- [pending] Pending item')).toEqual([
      { title: 'Done item', status: 'done' },
      { title: 'Pending item', status: 'pending' },
    ]);

    expect(extractDisplayTodoItems('Updated todos: [{"content":"Inspect","status":"active"}]')).toEqual([
      { title: 'Inspect', status: 'in_progress' },
    ]);
  });

  it('prefers explicit todo display blocks for tool calls', () => {
    expect(
      getTodoItemsForToolCall({
        name: 'SetTodoList',
        argumentsText: '{"items":[{"title":"Args","status":"pending"}]}',
        resultText: '- [done] Result',
        displayBlocks: [{ type: 'todo', items: [{ title: 'Display', status: 'done' }] }],
      }),
    ).toEqual([{ title: 'Display', status: 'done' }]);
  });

  it('filters brief display blocks without dropping approval display semantics', () => {
    expect(
      getRichToolDisplayBlocks([
        { type: 'brief', text: 'summary' },
        { type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' },
        { type: 'todo', items: [{ title: 'Review', status: 'pending' }] },
        { type: 'command', language: 'bash', command: 'pnpm test' },
        { type: 'file-op', operation: 'write', path: 'a.ts' },
      ]),
    ).toEqual([
      { type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' },
      { type: 'todo', items: [{ title: 'Review', status: 'pending' }] },
      { type: 'command', language: 'bash', command: 'pnpm test' },
      { type: 'file-op', operation: 'write', path: 'a.ts' },
    ]);
  });
});
