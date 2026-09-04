import { describe, expect, it } from 'vitest';

import {
  computeEditStats,
  computeWriteStats,
  pickChip,
} from '#/tui/components/messages/tool-renderers/chip';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function call(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return { id: 'tc', name, args };
}

function result(output: string, isError = false): ToolResultBlockData {
  return { tool_call_id: 'tc', output, is_error: isError };
}

function chipFor(name: string, args: Record<string, unknown>, out: ToolResultBlockData): string {
  const provider = pickChip(name);
  return strip(provider?.(call(name, args), out) ?? '');
}

describe('chip registry', () => {
  it('Bash has no chip (exit code is not surfaced)', () => {
    expect(pickChip('AskUserQuestion')).toBeUndefined();
  });

  it('Edit chip shows +N -M from args diff', () => {
    const c = chipFor(
      'Edit',
      { path: 'foo.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' },
      result('Replaced 1 occurrence in foo.ts'),
    );
    expect(c).toMatch(/\+\d+/);
    expect(c).toMatch(/-\d+/);
  });

  it('Write chip shows N lines from content arg', () => {
    expect(chipFor('Write', { path: 'a.txt', content: 'a\nb\nc\n' }, result('Wrote a.txt'))).toBe(
      '3 lines',
    );
  });

  it('Read chip shows line count', () => {
    expect(chipFor('Read', { path: 'a.ts' }, result('1\tfoo\n2\tbar\n3\tbaz'))).toBe('3 lines');
  });

  it('Read chip handles single line as singular', () => {
    expect(chipFor('Read', { path: 'a.ts' }, result('1\tfoo'))).toBe('1 line');
  });

  it('Grep chip counts files in the default files_with_matches mode', () => {
    expect(chipFor('Grep', { pattern: 'foo' }, result('a.ts\nb.ts\nc.ts'))).toBe('3 files');
    expect(chipFor('Grep', { pattern: 'foo' }, result('a.ts'))).toBe('1 file');
  });

  it('Grep chip counts matches and their files in content mode', () => {
    const content = { pattern: 'foo', output_mode: 'content' };
    expect(chipFor('Grep', content, result('src/a.ts:1:foo\nsrc/a.ts:9:foo\nsrc/b.ts:2:foo'))).toBe(
      '3 matches across 2 files',
    );
    expect(chipFor('Grep', content, result('src/a.ts:1:foo\nsrc/a.ts:9:foo'))).toBe(
      '2 matches in 1 file',
    );
    // Context lines and group separators are not matches.
    expect(
      chipFor('Grep', content, result('src/a.ts-1-import x\nsrc/a.ts:2:foo\n--\nsrc/b.ts:5:foo')),
    ).toBe('2 matches across 2 files');
  });

  it('Grep chip sums the per-file counts in count_matches mode', () => {
    expect(
      chipFor(
        'Grep',
        { pattern: 'foo', output_mode: 'count_matches' },
        result('Found 5 total occurrences across 2 files.\nsrc/a.ts:3\nsrc/b.ts:2'),
      ),
    ).toBe('5 matches across 2 files');
  });

  it('Grep chip counts files only when unnumbered content rows can be context', () => {
    // `-n: false` with context flags: match and context rows are both
    // `path:text` (the backend separates fields with ':' unconditionally),
    // so an exact match count is unknowable and the chip falls back to files.
    const unnumberedContext = { pattern: 'foo', output_mode: 'content', '-n': false, '-C': 1 };
    expect(
      chipFor('Grep', unnumberedContext, result('src/a.ts:import x\nsrc/a.ts:foo\nsrc/b.ts:foo')),
    ).toBe('2 files');
    // Without context flags every row is a match, so the count stays exact.
    const unnumbered = { pattern: 'foo', output_mode: 'content', '-n': false };
    expect(chipFor('Grep', unnumbered, result('src/a.ts:foo\nsrc/a.ts:bar\nsrc/b.ts:foo'))).toBe(
      '3 matches across 2 files',
    );
  });

  it('Grep chip leaves the notices out of the count', () => {
    expect(chipFor('Grep', { pattern: 'foo' }, result(''))).toBe('no matches');
    expect(chipFor('Grep', { pattern: 'foo' }, result('No matches found'))).toBe('no matches');
    expect(
      chipFor(
        'Grep',
        { pattern: 'foo' },
        result('a.ts\nb.ts\nResults truncated to 2 lines (total: 9). Use offset=2 to see more.'),
      ),
    ).toBe('9 files');
  });

  it('Glob chip leaves the empty-result sentence out of the count', () => {
    expect(chipFor('Glob', { pattern: '*.ts' }, result('No matches found'))).toBe('no files');
  });

  it('Glob chip leaves the backend diagnostics out of the count', () => {
    expect(
      chipFor(
        'Glob',
        { pattern: '**/*.ts' },
        result(
          [
            'Glob timed out after 60s; partial results returned.',
            '[stdout truncated at 65536 bytes; results may be incomplete — use a more specific pattern]',
            'Glob completed with warnings; some directories could not be read: EACCES /root',
            '[Truncated at 200 matches — use a more specific pattern]',
            'Only the first 200 matches are returned.',
            'a.ts',
            'b.ts',
            'Found 200 matches',
          ].join('\n'),
        ),
      ),
    ).toBe('2 files');
  });

  it('Glob chip shows file count', () => {
    expect(chipFor('Glob', { pattern: '**/*.ts' }, result('a.ts\nb.ts'))).toBe('2 files');
  });

  it('FetchURL chip shows size and is non-empty', () => {
    const out = chipFor('FetchURL', { url: 'https://example.com' }, result('hello world'));
    expect(out).toMatch(/\d+\s*B/);
  });

  it('WebSearch chip shows result count', () => {
    expect(chipFor('WebSearch', { query: 'kimi' }, result('1. Alpha\n2. Beta\n3. Gamma'))).toBe(
      '3 results',
    );
  });

  it('Think tool has no chip', () => {
    expect(pickChip('Think')).toBeUndefined();
  });

  it('GetGoal chip shows the current status', () => {
    expect(chipFor('GetGoal', {}, result('{"goal":{"status":"active"}}'))).toBe('active');
  });

  it('GetGoal chip shows when there is no current goal', () => {
    expect(chipFor('GetGoal', {}, result('{"goal":null}'))).toBe('no goal');
  });

  it('CreateGoal chip shows the created status', () => {
    expect(chipFor('CreateGoal', { objective: 'Ship feature X' }, result('{"goal":{"status":"active"}}'))).toBe('active');
  });

  it('SetGoalBudget has no chip because the budget is in the header argument', () => {
    expect(pickChip('SetGoalBudget')).toBeUndefined();
  });

  it('UpdateGoal has no chip because the status is in the header label', () => {
    expect(pickChip('UpdateGoal')).toBeUndefined();
  });

  it('Unknown tools have no chip', () => {
    expect(pickChip('SomethingElse')).toBeUndefined();
  });
});

describe('computeWriteStats', () => {
  it('returns zero lines for empty content', () => {
    expect(computeWriteStats({})).toEqual({ lines: 0 });
    expect(computeWriteStats({ content: '' })).toEqual({ lines: 0 });
  });

  it('counts a single line with no trailing newline', () => {
    expect(computeWriteStats({ content: 'hello' })).toEqual({ lines: 1 });
  });

  it('ignores trailing newline so "a\\nb\\n" is 2 lines', () => {
    expect(computeWriteStats({ content: 'a\nb\n' })).toEqual({ lines: 2 });
    expect(computeWriteStats({ content: 'a\nb' })).toEqual({ lines: 2 });
  });
});

describe('computeEditStats', () => {
  it('returns zero when both strings are empty', () => {
    expect(computeEditStats({})).toEqual({ added: 0, removed: 0 });
    expect(computeEditStats({ old_string: '', new_string: '' })).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it('counts added and removed lines for a replacement', () => {
    const stats = computeEditStats({ old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' });
    expect(stats.added).toBeGreaterThan(0);
    expect(stats.removed).toBeGreaterThan(0);
  });

  it('counts only adds when old is empty', () => {
    const stats = computeEditStats({ old_string: '', new_string: 'x\ny\nz' });
    expect(stats.added).toBe(3);
    expect(stats.removed).toBe(0);
  });
});

describe('Bash chip', () => {
  it('counts the hidden output lines once they outgrow the collapsed card', () => {
    const chip = pickChip('Bash')!;
    const call = { id: 'tc', name: 'Bash', args: { command: 'ls' } };
    // One outcome line stands in for the rest, so the chip counts what is hidden.
    expect(chip(call, { tool_call_id: 'tc', output: 'a\n\nb\nc\nd\n', is_error: false })).toBe('3 more lines');
    expect(chip(call, { tool_call_id: 'tc', output: 'a\nb\nc\nd\ne', is_error: false })).toBe('4 more lines');
    // Up to three lines are shown whole on the collapsed card, so no chip.
    expect(chip(call, { tool_call_id: 'tc', output: 'a\n\nb\nc\n', is_error: false })).toBe('');
    expect(chip(call, { tool_call_id: 'tc', output: 'only', is_error: false })).toBe('');
    expect(chip(call, { tool_call_id: 'tc', output: '', is_error: false })).toBe('');
  });
});

describe('Bash chip on a failed command', () => {
  it('stays silent so the error preview trailer owns the hidden-line count', () => {
    const chip = pickChip('Bash')!;
    const call = { id: 'tc', name: 'Bash', args: { command: 'ls' } };
    expect(chip(call, { tool_call_id: 'tc', output: 'a\nb\nc\nd\ne', is_error: true })).toBe('');
  });
});

describe('Grep chip without line numbers', () => {
  it('counts every row as a match but each file once', () => {
    expect(
      chipFor(
        'Grep',
        { pattern: 'foo', output_mode: 'content', '-n': false },
        result('a.ts:foo\na.ts:foo again\nb.ts:foo'),
      ),
    ).toBe('3 matches across 2 files');
  });
});

describe('Grep chip on paginated and unusual output', () => {
  it('uses the count-mode summary total instead of the current page', () => {
    expect(
      chipFor(
        'Grep',
        { pattern: 'foo', output_mode: 'count_matches', head_limit: 2 },
        result(
          'Found 40 total occurrences across 12 files.\nResults truncated to 2 lines (total: 12). Use offset=2 to see more.\na.ts:3\nb.ts:2',
        ),
      ),
    ).toBe('40 matches across 12 files');
  });

  it('keeps a Windows drive letter inside the path of an unnumbered content row', () => {
    expect(
      chipFor(
        'Grep',
        { pattern: 'foo', output_mode: 'content', '-n': false },
        result('C:/outside/a.ts:foo\nC:/outside/b.ts:foo'),
      ),
    ).toBe('2 matches across 2 files');
  });

  it('leaves the continuation lines of a Glob traversal warning out of the file count', () => {
    expect(
      chipFor(
        'Glob',
        { pattern: '**/*.ts' },
        result(
          'Glob completed with warnings; some directories could not be read: rg: /x: Permission denied (os error 13)\nrg: /y: Permission denied (os error 13)\na.ts\nb.ts',
        ),
      ),
    ).toBe('2 files');
  });
});
