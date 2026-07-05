import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFileMentions } from '@/tui/utils/file-mention';

let workDir: string;
let outsideDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mention-work-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'mention-outside-'));
  mkdirSync(join(workDir, 'src'));
  writeFileSync(join(workDir, 'src', 'main.ts'), '');
  writeFileSync(join(workDir, '深度研究报告.docx'), '');
  writeFileSync(join(workDir, 'with space.md'), '');
  writeFileSync(join(outsideDir, 'report.docx'), '');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('resolveFileMentions', () => {
  it('rewrites a cwd-relative mention to an absolute path and strips @', () => {
    const result = resolveFileMentions('look at @src/main.ts please', workDir);
    expect(result.text).toBe(`look at ${join(workDir, 'src', 'main.ts')} please`);
    expect(result.mentions).toEqual([
      { raw: '@src/main.ts', absolutePath: join(workDir, 'src', 'main.ts') },
    ]);
  });

  it('resolves non-ASCII file names', () => {
    const result = resolveFileMentions('读一下 @深度研究报告.docx', workDir);
    expect(result.text).toBe(`读一下 ${join(workDir, '深度研究报告.docx')}`);
    expect(result.mentions).toHaveLength(1);
  });

  it('resolves quoted mentions and re-quotes paths containing spaces', () => {
    const result = resolveFileMentions('see @"with space.md" now', workDir);
    expect(result.text).toBe(`see "${join(workDir, 'with space.md')}" now`);
    expect(result.mentions[0]?.raw).toBe('@"with space.md"');
  });

  it('resolves absolute-path mentions outside the work dir', () => {
    const target = join(outsideDir, 'report.docx');
    const result = resolveFileMentions(`summarize @${target}`, workDir);
    expect(result.text).toBe(`summarize ${target}`);
  });

  it('retries without trailing CJK punctuation and keeps it in the text', () => {
    const result = resolveFileMentions('先看 @src/main.ts，再动手。', workDir);
    expect(result.text).toBe(`先看 ${join(workDir, 'src', 'main.ts')}，再动手。`);
    expect(result.mentions[0]?.raw).toBe('@src/main.ts');
  });

  it('leaves non-existent paths untouched (existence gating)', () => {
    const text = 'install @types/node and @anthropic-ai/sdk';
    expect(resolveFileMentions(text, workDir)).toEqual({ text, mentions: [] });
  });

  it('ignores @ that is not at a token start (emails)', () => {
    const text = 'mail me at foo@src please';
    expect(resolveFileMentions(text, workDir)).toEqual({ text, mentions: [] });
  });

  it('resolves multiple mentions in one message', () => {
    const result = resolveFileMentions('diff @src/main.ts and @"with space.md"', workDir);
    expect(result.mentions).toHaveLength(2);
    expect(result.text).toBe(
      `diff ${join(workDir, 'src', 'main.ts')} and "${join(workDir, 'with space.md')}"`,
    );
  });

  it('resolves directory mentions with a trailing slash', () => {
    const result = resolveFileMentions('scan @src/ deeply', workDir);
    expect(result.text).toBe(`scan ${join(workDir, 'src')} deeply`);
  });

  it('handles mentions at the start of a line in multi-line text', () => {
    const result = resolveFileMentions('first line\n@src/main.ts is key', workDir);
    expect(result.text).toBe(`first line\n${join(workDir, 'src', 'main.ts')} is key`);
  });

  it('leaves a bare @ and an unterminated quote untouched', () => {
    const text = 'a @ b and @"unterminated';
    expect(resolveFileMentions(text, workDir)).toEqual({ text, mentions: [] });
  });

  it('does not truncate a real extension when the file is missing', () => {
    // `src` exists as a directory, but `@src.md` must not fall back to it.
    const text = 'open @src.md';
    expect(resolveFileMentions(text, workDir)).toEqual({ text, mentions: [] });
  });
});
