import { describe, expect, it } from 'vitest';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';

import { editedFileCount, editedFileMarkers, isStaleSince, turnFileEditCounts } from '../src/lib/fileStaleness';
import { normalizePathKey } from '../src/chatTurnRendering';

function tool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1',
    name: 'Edit',
    arg: JSON.stringify({ path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' }),
    status: 'ok',
    ...over,
  } as ToolCall;
}

function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: 'turn-1',
    role: 'assistant',
    no: 1,
    text: '',
    ...over,
  } as ChatTurn;
}

describe('turnFileEditCounts', () => {
  it('counts completed edit/write tool calls per normalized path', () => {
    const t = turn({
      tools: [
        tool({ id: 'a' }),
        tool({ id: 'b', name: 'Write', arg: JSON.stringify({ file_path: '/repo/src/a.ts', content: 'n' }) }),
        tool({ id: 'c', name: 'Read', arg: JSON.stringify({ path: '/repo/src/a.ts' }) }),
      ],
    });
    const counts = turnFileEditCounts(t);
    expect(counts.get(normalizePathKey('/repo/src/a.ts'))).toBe(2);
    expect(counts.size).toBe(1);
  });

  it('skips non-ok and pathless tool calls', () => {
    const t = turn({
      tools: [
        tool({ id: 'a', status: 'running' }),
        tool({ id: 'b', status: 'error' }),
        tool({ id: 'c', arg: JSON.stringify({ old_string: 'x', new_string: 'y' }) }),
      ],
    });
    expect(turnFileEditCounts(t).size).toBe(0);
  });

  it('normalizes relative and backslash paths to the same key form', () => {
    const t = turn({
      tools: [
        tool({ id: 'a', arg: JSON.stringify({ path: 'src/./sub/../a.ts' }) }),
        tool({ id: 'b', arg: JSON.stringify({ path: 'src\\a.ts' }) }),
      ],
    });
    const counts = turnFileEditCounts(t);
    expect(counts.size).toBe(1);
    expect(counts.get('src/a.ts')).toBe(2);
  });

  it('reads blocks from turn.blocks when present', () => {
    const t = turn({
      blocks: [{ kind: 'tool', tool: tool() } as ChatTurn['blocks'] extends (infer B)[] | undefined ? B : never],
    });
    expect(turnFileEditCounts(t).size).toBe(1);
  });

  it('registers relative tool paths under both raw and cwd-resolved keys', () => {
    const t = turn({ tools: [tool({ arg: JSON.stringify({ path: '../shared/a.ts' }) })] });
    const counts = turnFileEditCounts(t, '/repo');
    expect(counts.get(normalizePathKey('../shared/a.ts'))).toBe(1);
    expect(counts.get('/shared/a.ts')).toBe(1);
    expect(turnFileEditCounts(t).get('/shared/a.ts')).toBeUndefined();
  });
});

describe('editedFileMarkers', () => {
  it('later turns overwrite earlier markers for the same path', () => {
    const path = normalizePathKey('/repo/src/a.ts');
    const t1 = turn({ id: 'turn-1', tools: [tool({ id: 'a' })] });
    const t2 = turn({ id: 'turn-2', tools: [tool({ id: 'b' })] });
    const markers = editedFileMarkers([t1, t2]);
    expect(markers.get(path)).toBe('turn-2:1');
  });

  it('marker changes when the same turn edits the path again', () => {
    const path = normalizePathKey('/repo/src/a.ts');
    const t1 = turn({ id: 'turn-1', tools: [tool({ id: 'a' })] });
    const before = editedFileMarkers([t1]);
    const t1More = turn({ id: 'turn-1', tools: [tool({ id: 'a' }), tool({ id: 'b' })] });
    const after = editedFileMarkers([t1More]);
    expect(before.get(path)).toBe('turn-1:1');
    expect(after.get(path)).toBe('turn-1:2');
  });
});

describe('isStaleSince', () => {
  const path = normalizePathKey('/repo/src/a.ts');

  it('is fresh when markers match the snapshot', () => {
    const markers = new Map([[path, 'turn-1:1']]);
    const snapshot = new Map([[path, 'turn-1:1']]);
    expect(isStaleSince(markers, snapshot, [path])).toBe(false);
  });

  it('is stale when the marker advanced past the snapshot', () => {
    const markers = new Map([[path, 'turn-2:1']]);
    const snapshot = new Map([[path, 'turn-1:1']]);
    expect(isStaleSince(markers, snapshot, [path])).toBe(true);
  });

  it('is stale when the path was first edited after the snapshot', () => {
    const markers = new Map([[path, 'turn-1:1']]);
    const snapshot = new Map<string, string | undefined>([[path, undefined]]);
    expect(isStaleSince(markers, snapshot, [path])).toBe(true);
  });

  it('checks every candidate key form', () => {
    const markers = new Map([[path, 'turn-1:1']]);
    const snapshot = new Map([
      [path, 'turn-1:1'],
      ['src/a.ts', 'turn-0:1'],
    ]);
    expect(isStaleSince(markers, snapshot, [path, 'src/a.ts'])).toBe(true);
  });
});

describe('editedFileCount', () => {
  it('counts distinct files written by completed edit tools across a turn group', () => {
    const group = [
      turn({ tools: [tool({ id: 'a' }), tool({ id: 'b', name: 'MultiEdit', arg: JSON.stringify({ file_path: 'src/a.ts', edits: [] }) })] }),
      turn({
        id: 'turn-2',
        tools: [
          tool({ id: 'c', name: 'write', arg: JSON.stringify({ path: 'src/b.ts', content: '' }) }),
          tool({ id: 'd', name: 'Edit', status: 'error' }),
          tool({ id: 'e', name: 'Read', arg: JSON.stringify({ path: 'src/c.ts' }) }),
        ],
      }),
    ];
    expect(editedFileCount(group, '/repo')).toBe(2);
    expect(editedFileCount([turn({ tools: [tool({ name: 'Bash', arg: 'sed -i s/a/b/ x.ts' })] })])).toBe(0);
  });
});
