import { describe, expect, it } from 'vitest';

import { getDisplayPartCopyContent, type DisplayPart } from '../src';

describe('getDisplayPartCopyContent', () => {
  it('copies text parts', () => {
    expect(getDisplayPartCopyContent({ type: 'text', text: 'hello' })).toBe('hello');
    expect(getDisplayPartCopyContent({ type: 'text', text: '   ' })).toBeNull();
  });

  it('copies only finished thinking parts', () => {
    expect(getDisplayPartCopyContent({ type: 'thinking', text: 'draft' })).toBeNull();
    expect(getDisplayPartCopyContent({ type: 'thinking', text: 'final', finished: true })).toBe('final');
  });

  it('serializes media parts as stable placeholders', () => {
    expect(getDisplayPartCopyContent({ type: 'media', kind: 'image', url: 'data:image/png;base64,abc', id: 'img-1' })).toBe('[image img-1]');
  });

  it('serializes plan parts', () => {
    const part: DisplayPart = {
      type: 'plan',
      plan: {
        entries: [
          { content: 'Inspect codebase', status: 'completed', priority: 'high' },
          { content: 'Implement change', status: 'in_progress' },
        ],
      },
    };

    expect(getDisplayPartCopyContent(part)).toBe('- [completed] Inspect codebase (high)\n- [in_progress] Implement change');
  });

  it('serializes tool call parts with display block summaries', () => {
    const part: DisplayPart = {
      type: 'tool-call',
      id: 'tool-1',
      name: 'Edit',
      status: 'success',
      argumentsText: '{"path":"a.ts"}',
      resultText: 'ok',
      displayBlocks: [
        { type: 'brief', text: 'Updated a.ts' },
        { type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' },
        { type: 'todo', items: [{ title: 'Review diff', status: 'done' }] },
        { type: 'command', language: 'bash', command: 'pnpm test', cwd: '/repo', danger: 'none', description: 'Run tests' },
        { type: 'file-op', operation: 'read', path: 'a.ts', detail: 'Inspect changes' },
        { type: 'file-content', path: 'a.ts', content: 'const a = 1;' },
        { type: 'url-fetch', url: 'https://example.com', method: 'POST' },
        { type: 'search', query: 'TODO', scope: 'src' },
        { type: 'invocation', kind: 'skill', name: 'review', description: 'Review diff' },
        { type: 'background-task', taskId: 'task-1', kind: 'shell', status: 'running', description: 'Run tests' },
      ],
    };

    expect(getDisplayPartCopyContent(part)).toBe(
      'Tool: Edit\nStatus: success\n\nArguments:\n{"path":"a.ts"}\n\nResult:\nok\n\nDisplay:\nUpdated a.ts\n\nDiff: a.ts\n\nTodo:\n- [done] Review diff\n\nCommand (bash): pnpm test\ncwd: /repo\nDanger: none\nRun tests\n\nread a.ts\nInspect changes\n\nFile: a.ts\nconst a = 1;\n\nPOST https://example.com\n\nSearch: TODO\nscope: src\n\nskill: review\nReview diff\n\nBackground task task-1 (shell, running): Run tests',
    );
  });

  it('does not copy non-output display parts', () => {
    const parts: DisplayPart[] = [
      {
        type: 'approval',
        requestId: '1',
        toolCallId: 'tool-1',
        sender: 'agent',
        action: 'run',
        description: 'Run command',
      },
      { type: 'compaction', status: 'completed' },
      { type: 'error', error: { code: 'ERROR', message: 'failed', phase: 'runtime' } },
      { type: 'interrupt', reason: 'cancelled' },
      { type: 'status', status: { contextUsage: 0.1 } },
    ];

    for (const part of parts) {
      expect(getDisplayPartCopyContent(part)).toBeNull();
    }
  });
});
