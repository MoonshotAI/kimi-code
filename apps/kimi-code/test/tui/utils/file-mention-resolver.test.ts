import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildTextWithResolvedMentions,
  resolveFileMentions,
} from '#/tui/utils/file-mention-resolver';

describe('file-mention-resolver', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeWorkDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'kimi-mention-'));
    return dir;
  }

  it('resolves a bare @mention to an absolute path relative to workDir', () => {
    const workDir = makeWorkDir();
    writeFileSync(join(workDir, 'foo.zip'), '');

    const resolutions = resolveFileMentions('unzip @foo.zip please', workDir, []);

    expect(resolutions).toEqual([
      { mention: '@foo.zip', absolutePath: join(workDir, 'foo.zip'), isDirectory: false },
    ]);
  });

  it('resolves a quoted @mention containing spaces', () => {
    const workDir = makeWorkDir();
    writeFileSync(join(workDir, 'my file.txt'), '');

    const resolutions = resolveFileMentions('read @"my file.txt" now', workDir, []);

    expect(resolutions).toEqual([
      { mention: '@my file.txt', absolutePath: join(workDir, 'my file.txt'), isDirectory: false },
    ]);
  });

  it('resolves against additionalDirs when not found under workDir', () => {
    const workDir = makeWorkDir();
    const extra = mkdtempSync(join(tmpdir(), 'kimi-mention-extra-'));
    try {
      mkdirSync(join(extra, 'sub'), { recursive: true });
      writeFileSync(join(extra, 'sub', 'bar.txt'), '');

      const resolutions = resolveFileMentions('@sub/bar.txt', workDir, [extra]);

      expect(resolutions).toEqual([
        { mention: '@sub/bar.txt', absolutePath: join(extra, 'sub', 'bar.txt'), isDirectory: false },
      ]);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it('flags directory mentions', () => {
    const workDir = makeWorkDir();
    mkdirSync(join(workDir, 'assets'));

    const resolutions = resolveFileMentions('@assets/', workDir, []);

    expect(resolutions).toEqual([
      { mention: '@assets/', absolutePath: join(workDir, 'assets'), isDirectory: true },
    ]);
  });

  it('ignores mentions that do not exist on disk', () => {
    const workDir = makeWorkDir();

    const resolutions = resolveFileMentions('@does-not-exist.txt', workDir, []);

    expect(resolutions).toEqual([]);
  });

  it('does not treat an email-style @ (not preceded by a delimiter) as a mention', () => {
    const workDir = makeWorkDir();
    writeFileSync(join(workDir, 'example.com'), '');

    const resolutions = resolveFileMentions('user@example.com', workDir, []);

    expect(resolutions).toEqual([]);
  });

  it('buildTextWithResolvedMentions appends a grounding block when something resolves', () => {
    const workDir = makeWorkDir();
    writeFileSync(join(workDir, 'foo.zip'), '');

    const text = buildTextWithResolvedMentions('unzip @foo.zip', workDir, []);

    expect(text).toBe(`unzip @foo.zip\n\n<mentioned-files>\n- @foo.zip -> ${join(workDir, 'foo.zip')}\n</mentioned-files>`);
  });

  it('buildTextWithResolvedMentions returns the original text unchanged when nothing resolves', () => {
    const workDir = makeWorkDir();

    const text = buildTextWithResolvedMentions('unzip @missing.zip', workDir, []);

    expect(text).toBe('unzip @missing.zip');
  });
});
