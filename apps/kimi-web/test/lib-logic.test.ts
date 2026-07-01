import { describe, expect, it } from 'vitest';
import {
  collectFilePathAliases,
  findFilePathLinks,
  parseFilePathLinkCandidate,
} from '../src/lib/filePathLinks';
import { parseDiff } from '../src/lib/parseDiff';
import { buildDiffLines } from '../src/lib/diffLines';
import { buildEditDiffLines } from '../src/lib/toolDiff';
import { createCoalescedAsyncRunner } from '../src/lib/snapshotSync';
import { normalizeToolName, toolSummary } from '../src/lib/toolMeta';
import { resolveToolRenderer } from '../src/components/chat/tool-calls/toolRegistry';
import AgentTool from '../src/components/chat/tool-calls/AgentTool.vue';
import EditTool from '../src/components/chat/tool-calls/EditTool.vue';
import GenericTool from '../src/components/chat/tool-calls/GenericTool.vue';
import type { ToolCall } from '../src/types';

describe('parseDiff', () => {
  it('parses multiple files and keeps hunk line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      'diff --git a/src/comment.sql b/src/comment.sql',
      '@@ -5,1 +5,1 @@',
      '--- old comment',
      '+++ new comment',
    ].join('\n');

    expect(parseDiff(diff)).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { type: 'context', text: 'const a = 1;', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'const b = 2;', oldNo: 2 },
      { type: 'add', text: 'const b = 3;', newNo: 2 },
      { type: 'add', text: 'const c = 4;', newNo: 3 },
      { type: 'hunk', text: '@@ -5,1 +5,1 @@' },
      { type: 'del', text: '-- old comment', oldNo: 5 },
      { type: 'add', text: '++ new comment', newNo: 5 },
    ]);
  });
});

describe('buildDiffLines', () => {
  it('lines up context, deletions and additions with old/new line numbers', () => {
    const before = 'a\nb\nc';
    const after = 'a\nB\nc\nd';
    expect(buildDiffLines(before, after)).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 2 },
      { type: 'context', text: 'c', oldNo: 3, newNo: 3 },
      { type: 'add', text: 'd', newNo: 4 },
    ]);
  });

  it('treats an empty before as an all-addition write', () => {
    expect(buildDiffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x', newNo: 1 },
      { type: 'add', text: 'y', newNo: 2 },
    ]);
  });

  it('returns all context for identical texts and empty for two empties', () => {
    expect(buildDiffLines('a\nb', 'a\nb')).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'context', text: 'b', oldNo: 2, newNo: 2 },
    ]);
    expect(buildDiffLines('', '')).toEqual([]);
  });

  it('returns null when the LCS matrix would be too large', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line${i}`).join('\n');
    expect(buildDiffLines(big, `${big}\nextra`)).toBeNull();
  });

  it('returns null when one side is huge even though the matrix is small', () => {
    const huge = Array.from({ length: 6000 }, (_, i) => `line${i}`).join('\n');
    expect(buildDiffLines('one line', huge)).toBeNull();
  });
});

describe('buildEditDiffLines', () => {
  it('builds a diff for a single Edit', () => {
    const arg = JSON.stringify({ path: 'a.ts', old_string: 'a\nb', new_string: 'a\nB' });
    expect(buildEditDiffLines({ name: 'Edit', arg })).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 2 },
    ]);
  });

  it('falls back to output for replace_all edits', () => {
    const arg = JSON.stringify({ path: 'a.ts', old_string: 'a', new_string: 'b', replace_all: true });
    expect(buildEditDiffLines({ name: 'Edit', arg })).toBeNull();
  });

  it('falls back to output for every Write (new file or overwrite)', () => {
    expect(buildEditDiffLines({ name: 'Write', arg: JSON.stringify({ path: 'a.ts', content: 'x' }) })).toBeNull();
    expect(
      buildEditDiffLines({ name: 'Write', arg: JSON.stringify({ path: 'a.ts', content: 'x', mode: 'append' }) }),
    ).toBeNull();
  });

  it('returns null for non-edit/write tools', () => {
    expect(buildEditDiffLines({ name: 'Bash', arg: JSON.stringify({ command: 'ls' }) })).toBeNull();
  });
});

describe('filePathLinks', () => {
  it('rejects URLs and bare unknown filenames', () => {
    expect(parseFilePathLinkCandidate('https://example.com/a.ts')).toBeNull();
    expect(parseFilePathLinkCandidate('e2e-success.png')).toBeNull();
  });

  it('finds path links with line numbers and resolves aliases', () => {
    const aliases = collectFilePathAliases('<img src="/assets/demo.png">');
    expect(aliases.get('demo.png')).toBe('/assets/demo.png');

    expect(
      findFilePathLinks('Open src/a.ts#L12 and demo.png.', { aliases }),
    ).toMatchObject([
      { path: 'src/a.ts', line: 12, text: 'src/a.ts#L12' },
      { path: '/assets/demo.png', text: 'demo.png' },
    ]);
  });
});

describe('toolMeta', () => {
  it('normalizes common tool aliases', () => {
    expect(normalizeToolName('WebFetch')).toBe('web_fetch');
    expect(normalizeToolName('MultiEdit')).toBe('multi_edit');
    expect(normalizeToolName('TodoWrite')).toBe('todo');
    expect(normalizeToolName('rg')).toBe('grep');
  });

  it('summarizes tool arguments for card headers', () => {
    expect(
      toolSummary('Read', JSON.stringify({ path: 'src/a.ts', offset: 10, limit: 5 })),
    ).toBe('src/a.ts:10-15');
    expect(toolSummary('Read', '{}')).toBe('');
    expect(toolSummary('Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test');
    expect(
      toolSummary('WebFetch', JSON.stringify({ url: 'https://example.com/path/to' })),
    ).toBe('example.com/path');
  });
});

describe('resolveToolRenderer', () => {
  // Minimal ToolCall factory — resolveToolRenderer only reads `name`, `status`
  // and `media`, so the rest is filled with placeholders.
  const tool = (name: string, status: ToolCall['status'] = 'running'): ToolCall => ({
    id: 't1',
    name,
    arg: '',
    status,
  });

  // Regression: normalizeToolName() folds `agent`/`subagent` into the canonical
  // `task` kind, so the renderer must match on `task`. If it matched on the raw
  // `agent` string these calls would fall through to GenericTool and lose the
  // inline "Open" button for the subagent detail panel.
  it('routes Agent / subagent calls to the Agent renderer', () => {
    expect(resolveToolRenderer(tool('agent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('Agent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('subagent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('task'))).toBe(AgentTool);
  });

  it('routes edit-like calls to the Edit renderer', () => {
    expect(resolveToolRenderer(tool('edit'))).toBe(EditTool);
    expect(resolveToolRenderer(tool('write'))).toBe(EditTool);
    expect(resolveToolRenderer(tool('multi_edit'))).toBe(EditTool);
  });

  it('falls back to the Generic renderer for unknown tools', () => {
    expect(resolveToolRenderer(tool('bash'))).toBe(GenericTool);
    expect(resolveToolRenderer(tool('read'))).toBe(GenericTool);
  });
});

describe('createCoalescedAsyncRunner', () => {
  it('reuses the in-flight promise for the same key', async () => {
    let runs = 0;
    let resolveRun!: () => void;
    const runner = createCoalescedAsyncRunner(async (_key: string) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return runs;
    });

    const first = runner.run('session-a');
    const second = runner.run('session-a');

    expect(runs).toBe(1);
    resolveRun();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(runs).toBe(1);
  });

  it('queues at most one rerun requested while a run is in flight', async () => {
    let runs = 0;
    const resolvers: Array<() => void> = [];
    const runner = createCoalescedAsyncRunner(async (_key: string) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      return runs;
    });

    const first = runner.run('session-a');
    runner.request('session-a');
    runner.request('session-a');
    expect(runs).toBe(1);

    resolvers[0]!();
    await first;
    await Promise.resolve();

    expect(runs).toBe(2);
    resolvers[1]!();
    await Promise.resolve();
    expect(runs).toBe(2);
  });
});
