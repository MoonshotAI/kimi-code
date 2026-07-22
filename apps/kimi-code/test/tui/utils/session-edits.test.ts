import { describe, expect, it } from 'vitest';

import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { collectSessionEditsByTurn } from '#/tui/utils/session-edits';

function baseEntry() {
  return { id: '1', kind: 'tool_call' as const, renderMode: 'plain' as const, content: '' };
}

function baseToolCall() {
  return { id: 'tc-1', name: 'Edit', args: {} };
}

function fileIoEdit(path: string, before: string, after: string) {
  return {
    ...baseEntry(),
    toolCallData: {
      ...baseToolCall(),
      name: 'Edit',
      display: { kind: 'file_io' as const, operation: 'edit' as const, path, before, after },
    },
  };
}

function fileIoWrite(path: string, content: string) {
  return {
    ...baseEntry(),
    toolCallData: {
      ...baseToolCall(),
      name: 'Write',
      display: { kind: 'file_io' as const, operation: 'write' as const, path, content },
    },
  };
}

function diffDisplay(path: string, before: string, after: string) {
  return {
    ...baseEntry(),
    toolCallData: {
      ...baseToolCall(),
      name: 'SomeTool',
      display: { kind: 'diff' as const, path, before, after },
    },
  };
}

describe('collectSessionEditsByTurn', () => {
  it('groups edits by turnId', () => {
    const edits = collectSessionEditsByTurn(
      [
        { ...fileIoEdit('a.ts', 'old', 'new'), turnId: 't1' },
        { ...fileIoWrite('b.ts', 'content'), turnId: 't2' },
        { ...fileIoEdit('a.ts', 'x', 'y'), turnId: 't1' },
      ],
      [],
    );
    expect(edits).toEqual([
      { turnId: 't1', path: 'a.ts', before: 'old', after: 'new' },
      { turnId: 't2', path: 'b.ts', before: '', after: 'content' },
      { turnId: 't1', path: 'a.ts', before: 'x', after: 'y' },
    ]);
  });

  it('falls back to components when entries lack tool_call data', () => {
    const component = new ToolCallComponent(
      {
        id: 'tc-1',
        name: 'Edit',
        args: {},
        display: {
          kind: 'file_io',
          operation: 'edit',
          path: 'c.ts',
          before: 'old',
          after: 'new',
        },
        turnId: 't3',
      },
      undefined,
    );
    const edits = collectSessionEditsByTurn([], [component]);
    expect(edits).toEqual([{ turnId: 't3', path: 'c.ts', before: 'old', after: 'new' }]);
  });

  it('collects Write tool calls as additions with turnId', () => {
    const edits = collectSessionEditsByTurn([
      { ...fileIoWrite('b.ts', 'content'), turnId: 't1' },
    ]);
    expect(edits).toEqual([{ turnId: 't1', path: 'b.ts', before: '', after: 'content' }]);
  });

  it('collects diff-style tool displays with turnId', () => {
    const edits = collectSessionEditsByTurn([
      { ...diffDisplay('c.ts', 'before', 'after'), turnId: 't2' },
    ]);
    expect(edits).toEqual([{ turnId: 't2', path: 'c.ts', before: 'before', after: 'after' }]);
  });

  it('ignores non-file tool calls', () => {
    const entries = [
      {
        ...baseEntry(),
        turnId: 't1',
        toolCallData: {
          ...baseToolCall(),
          name: 'Bash',
          display: { kind: 'command' as const, command: 'echo hi' },
        },
      },
    ];
    expect(collectSessionEditsByTurn(entries)).toEqual([]);
  });

  it('skips edit calls where before and after are identical', () => {
    const edits = collectSessionEditsByTurn([
      { ...fileIoEdit('a.ts', 'same', 'same'), turnId: 't1' },
    ]);
    expect(edits).toEqual([]);
  });

  it('uses undefined turnId when entry has no turnId', () => {
    const edits = collectSessionEditsByTurn([fileIoEdit('a.ts', 'old', 'new')]);
    expect(edits).toEqual([{ turnId: undefined, path: 'a.ts', before: 'old', after: 'new' }]);
  });

  it('collects edits from both entries and components preserving order', () => {
    const component = new ToolCallComponent(
      {
        id: 'tc-2',
        name: 'Write',
        args: {},
        display: {
          kind: 'file_io',
          operation: 'write',
          path: 'd.ts',
          content: 'from component',
        },
        turnId: 't4',
      },
      undefined,
    );
    const edits = collectSessionEditsByTurn(
      [{ ...fileIoEdit('a.ts', 'old', 'new'), turnId: 't1' }],
      [component],
    );
    expect(edits).toEqual([
      { turnId: 't1', path: 'a.ts', before: 'old', after: 'new' },
      { turnId: 't4', path: 'd.ts', before: '', after: 'from component' },
    ]);
  });

  it('deduplicates edits that appear in both entries and components', () => {
    const component = new ToolCallComponent(
      {
        id: 'tc-1',
        name: 'Edit',
        args: {},
        display: {
          kind: 'file_io',
          operation: 'edit',
          path: 'a.ts',
          before: 'old',
          after: 'new',
        },
        turnId: 't1',
      },
      undefined,
    );
    const edits = collectSessionEditsByTurn(
      [{ ...fileIoEdit('a.ts', 'old', 'new'), turnId: 't1' }],
      [component],
    );
    expect(edits).toEqual([{ turnId: 't1', path: 'a.ts', before: 'old', after: 'new' }]);
  });

  it('ignores components that do not look like tool calls', () => {
    const edits = collectSessionEditsByTurn([], [{ notAToolCall: true }]);
    expect(edits).toEqual([]);
  });
});
