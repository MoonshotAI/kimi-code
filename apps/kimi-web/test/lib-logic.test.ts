import { describe, expect, it } from 'vitest';
import {
  collectFilePathAliases,
  findFilePathLinks,
  parseFilePathLinkCandidate,
} from '../src/lib/filePathLinks';
import { parseDiff } from '../src/lib/parseDiff';
import { createCoalescedAsyncRunner } from '../src/lib/snapshotSync';
import { normalizeToolName, toolSummary } from '../src/lib/toolMeta';

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
