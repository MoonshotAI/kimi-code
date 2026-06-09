import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';

function ctrl(): AbortSignal {
  return new AbortController().signal;
}

const NO_FD = null;
const GOAL_COMMAND = {
  name: 'goal',
  description: 'Start or manage a goal',
  getArgumentCompletions: (prefix: string) =>
    prefix.length === 0
      ? [
          {
            value: 'status',
            label: 'status',
          },
        ]
      : null,
};

describe('FileMentionProvider', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'kimi-file-mention-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns null when there is no completable prefix', async () => {
    const provider = new FileMentionProvider([], workDir, NO_FD);
    const result = await provider.getSuggestions(['hello world'], 0, 11, { signal: ctrl() });
    expect(result).toBeNull();
  });

  it('does not complete slash arguments before existing free text', async () => {
    const provider = new FileMentionProvider([GOAL_COMMAND], workDir, NO_FD);
    const line = '/goal Fix the checkout docs';
    const result = await provider.getSuggestions([line], 0, '/goal '.length, { signal: ctrl() });
    expect(result).toBeNull();
  });

  it('still completes slash arguments at the end of an empty argument', async () => {
    const provider = new FileMentionProvider([GOAL_COMMAND], workDir, NO_FD);
    const line = '/goal ';
    const result = await provider.getSuggestions([line], 0, line.length, { signal: ctrl() });
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('');
    expect(result!.items.map((item) => item.value)).toEqual(['status']);
  });

  it('does not turn leading-whitespace slash into root path completion', async () => {
    const provider = new FileMentionProvider([], workDir, NO_FD);
    const result = await provider.getSuggestions([' /'], 0, 2, { signal: ctrl() });
    expect(result).toBeNull();
  });

  it('still allows forced root path completion after leading whitespace', async () => {
    const provider = new FileMentionProvider([], workDir, NO_FD);
    const result = await provider.getSuggestions([' /'], 0, 2, { signal: ctrl(), force: true });
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('/');
  });

  it('does not trigger the @ branch when @ is preceded by a non-delimiter', async () => {
    const provider = new FileMentionProvider([], workDir, NO_FD);
    const result = await provider.getSuggestions(['email@example'], 0, 13, { signal: ctrl() });
    expect(result).toBeNull();
  });

  it('uses a filesystem fallback for @ mentions when fd is not available', async () => {
    mkdirSync(join(workDir, 'src', 'components'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'components', 'Button.tsx'), 'export {};');
    writeFileSync(join(workDir, 'README.md'), 'readme');
    const provider = new FileMentionProvider([], workDir, NO_FD);

    const result = await provider.getSuggestions(['@but'], 0, 4, { signal: ctrl() });

    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('@but');
    expect(result!.items.map((item) => item.value)).toContain('@src/components/Button.tsx');
  });

  it('does not bypass fd filtering with filesystem suggestions when fd returns no matches', async () => {
    writeFileSync(join(workDir, 'README.md'), 'readme');
    const provider = new FileMentionProvider([], workDir, join(workDir, 'missing-fd'));

    const result = await provider.getSuggestions(['@read'], 0, 5, { signal: ctrl() });

    expect(result).toBeNull();
  });

  it('filesystem fallback returns folders and excludes .git', async () => {
    mkdirSync(join(workDir, 'src'));
    mkdirSync(join(workDir, '.git'));
    writeFileSync(join(workDir, '.git', 'config'), 'secret');
    const provider = new FileMentionProvider([], workDir, NO_FD);

    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });

    expect(result).not.toBeNull();
    const values = result!.items.map((item) => item.value);
    expect(values).toContain('@src/');
    expect(values.some((value) => value.startsWith('@.git'))).toBe(false);
  });

  it('filesystem fallback quotes paths with spaces', async () => {
    mkdirSync(join(workDir, 'my folder'));
    const provider = new FileMentionProvider([], workDir, NO_FD);

    const result = await provider.getSuggestions(['@my'], 0, 3, { signal: ctrl() });

    expect(result).not.toBeNull();
    expect(result!.items.map((item) => item.value)).toContain('@"my folder/"');
  });

  it('filesystem fallback does not recurse into symlinked directories', async () => {
    writeFileSync(join(workDir, 'target.txt'), 'target');
    symlinkSync('.', join(workDir, 'current'), 'dir');
    const provider = new FileMentionProvider([], workDir, NO_FD);

    const result = await provider.getSuggestions(['@target'], 0, 7, { signal: ctrl() });

    expect(result).not.toBeNull();
    const values = result!.items.map((item) => item.value);
    expect(values).toContain('@target.txt');
    expect(values.some((value) => value.startsWith('@current/'))).toBe(false);
  });

  it('delegates path suggestions to pi-tui for regular path completion', async () => {
    mkdirSync(join(workDir, 'src'));
    writeFileSync(join(workDir, 'README.md'), 'readme');
    const provider = new FileMentionProvider([], workDir, NO_FD);

    const result = await provider.getSuggestions([''], 0, 0, { signal: ctrl(), force: true });

    expect(result).not.toBeNull();
    expect(result!.items.map((item) => item.value)).toEqual(['src/', 'README.md']);
  });

  it('applyCompletion delegates file and directory insertion to pi-tui', () => {
    const provider = new FileMentionProvider([], workDir, NO_FD);

    const file = provider.applyCompletion(
      ['hey @read'],
      0,
      9,
      { value: '@README.md', label: 'README.md' },
      '@read',
    );
    expect(file.lines[0]).toBe('hey @README.md ');

    const dir = provider.applyCompletion(
      ['hey @sr'],
      0,
      7,
      { value: '@src/', label: 'src/' },
      '@sr',
    );
    expect(dir.lines[0]).toBe('hey @src/');
  });
});
