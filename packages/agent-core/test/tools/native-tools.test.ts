import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolExecution } from '../../src/loop/types';
import {
  isNativeToolsEnabled,
  NativeBashTool,
  NativeEditTool,
  NativeGlobTool,
  NativeGrepTool,
  NativeReadTool,
  NativeWriteTool,
  tryLoadNative,
} from '../../src/tools/builtin/native-tools';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';
import { createBackgroundManager } from '../agent/background/helpers';

const signal = new AbortController().signal;

function expectRunnable(execution: ToolExecution) {
  if (execution.isError === true) {
    throw new Error('Expected runnable execution.');
  }
  return execution;
}

function completedProcess(stdoutText: string): KaosProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.end(stdoutText);
  stderr.end();
  let exitCode: number | null = 0;
  return {
    stdin,
    stdout,
    stderr,
    pid: 1,
    get exitCode() {
      return exitCode;
    },
    wait: async () => 0,
    kill: async () => {
      exitCode = -1;
    },
    dispose: () => {},
  };
}

describe('native-tools flag gating', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is enabled by default', () => {
    expect(isNativeToolsEnabled()).toBe(true);
  });

  it('turns on via KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS', '1');
    expect(isNativeToolsEnabled()).toBe(true);
  });

  it('remains off for lenient falsy values', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS', '0');
    expect(isNativeToolsEnabled()).toBe(false);
  });
});

describe('native-tools integration', () => {
  let tmpDir: string;
  let workspace: { workspaceDir: string; additionalDirs: string[] };

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS', '1');
    tmpDir = mkdtempSync(join(tmpdir(), 'native-tools-test-'));
    workspace = { workspaceDir: tmpDir, additionalDirs: [] };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeKaos() {
    return createFakeKaos({
      normpath: (p: string) => p,
      getcwd: () => tmpDir,
    });
  }

  it('reads a file through the native module', async () => {
    writeFileSync(join(tmpDir, 'foo.txt'), 'hello\nworld');

    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read',
      args: { path: join(tmpDir, 'foo.txt') },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('hello');
    expect(result.output).toContain('world');
    expect(result.output).toContain('<system>');
    expect(result.output).toContain('</system>');
    expect(result.output).toContain('2 lines read');
  });

  it('reads a file with line_offset and n_lines', async () => {
    writeFileSync(join(tmpDir, 'lines.txt'), 'aaa\nbbb\nccc\nddd\neee');

    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read_offset',
      args: { path: join(tmpDir, 'lines.txt'), line_offset: 2, n_lines: 2 },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('bbb');
    expect(result.output).toContain('ccc');
    expect(result.output).not.toContain('aaa');
    expect(result.output).not.toContain('eee');
    expect(result.output).toContain('<system>');
  });

  it('reads a file with tail mode (negative line_offset)', async () => {
    writeFileSync(join(tmpDir, 'tail.txt'), 'aaa\nbbb\nccc\nddd\neee');

    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read_tail',
      args: { path: join(tmpDir, 'tail.txt'), line_offset: -3 },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('ccc');
    expect(result.output).toContain('ddd');
    expect(result.output).toContain('eee');
    expect(result.output).not.toContain('aaa');
    expect(result.output).toContain('<system>');
  });

  it('writes a file through the native module', async () => {
    const tool = new NativeWriteTool(makeKaos(), workspace, 'Write a file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_write',
      args: { path: join(tmpDir, 'out.txt'), content: 'hello world' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Wrote');
    expect(result.output).toContain('out.txt');
  });

  it('edits a file through the native module', async () => {
    writeFileSync(join(tmpDir, 'edit.txt'), 'foo bar foo');

    const tool = new NativeEditTool(makeKaos(), workspace, 'Edit a file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_edit',
      args: {
        path: join(tmpDir, 'edit.txt'),
        old_string: 'foo',
        new_string: 'baz',
        replace_all: true,
      },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Replaced 2 occurrences');
  });

  it('greps a file through the native module', async () => {
    writeFileSync(join(tmpDir, 'grep.txt'), 'first line\nneedle line\nlast line');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep',
      args: { pattern: 'needle', path: join(tmpDir, 'grep.txt'), output_mode: 'content' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('needle');
  });

  it('globs files through the native module', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.ts'), '');

    const tool = new NativeGlobTool(makeKaos(), workspace, 'Find files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_glob',
      args: { pattern: join(tmpDir, '*.ts') },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
  });

  it('glob relativizes results under the workspace', async () => {
    writeFileSync(join(tmpDir, 'file.ts'), '');
    const globWorkspace = { workspaceDir: tmpDir, additionalDirs: [] };
    const tool = new NativeGlobTool(makeKaos(), globWorkspace, 'Find files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_glob_rel',
      args: { pattern: '*.ts' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('file.ts');
    expect(result.output).not.toContain(tmpDir);
  });

  it('runs a bash command through the native module', async () => {
    const kaos = createFakeKaos({
      getcwd: () => tmpDir,
      execWithEnv: async () => completedProcess('hello\n'),
    });
    const tool = new NativeBashTool(kaos, tmpDir, createBackgroundManager().manager);
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_bash',
      args: { command: 'echo hello' },
      signal,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('hello');
  });

  it('reports a missing read target as an error', async () => {
    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read',
      args: { path: join(tmpDir, 'missing.txt') },
      signal,
    });

    expect(result.isError).toBe(true);
  });

  it('grep redacts sensitive files instead of returning their contents', async () => {
    writeFileSync(join(tmpDir, '.env'), 'SECRET_TOKEN=abcdef123\nDATABASE_URL=postgres://x');
    writeFileSync(join(tmpDir, 'safe.txt'), 'SECRET_TOKEN=public-marker');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep',
      args: { pattern: 'SECRET_TOKEN', path: tmpDir, output_mode: 'content' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).not.toContain('abcdef123');
    expect(result.output).toContain('Filtered');
    expect(result.output).toContain('.env');
    expect(result.output).toContain('public-marker');
  });

  it('grep filters by file type', async () => {
    writeFileSync(join(tmpDir, 'match.ts'), 'needle in ts');
    writeFileSync(join(tmpDir, 'match.py'), 'needle in py');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep_type',
      args: { pattern: 'needle', path: tmpDir, type: 'ts', output_mode: 'content' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('needle in ts');
    expect(result.output).not.toContain('needle in py');
  });

  it('grep count_matches mode includes a summary message', async () => {
    writeFileSync(join(tmpDir, 'counts.txt'), 'needle line\nneedle again\nneedle third');
    writeFileSync(join(tmpDir, 'nope.txt'), 'nothing here');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep_count',
      args: { pattern: 'needle', path: tmpDir, output_mode: 'count_matches' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('counts.txt');
    expect(result.output).toContain('3');
    expect(result.message).toContain('Found');
    expect(result.message).toContain('occurrence');
  });

  it('grep files_with_matches mode lists file paths', async () => {
    writeFileSync(join(tmpDir, 'match1.txt'), 'needle here');
    writeFileSync(join(tmpDir, 'match2.txt'), 'needle there');
    writeFileSync(join(tmpDir, 'nope.txt'), 'nothing');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep_fwm',
      args: { pattern: 'needle', path: tmpDir, output_mode: 'files_with_matches' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('match1.txt');
    expect(result.output).toContain('match2.txt');
    expect(result.output).not.toContain('nope.txt');
  });

  it('grep skips VCS metadata directories', async () => {
    mkdirSync(join(tmpDir, '.git'), { recursive: true });
    writeFileSync(join(tmpDir, '.git', 'HEAD'), 'needle inside git');
    writeFileSync(join(tmpDir, 'tracked.txt'), 'needle outside git');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep_vcs',
      args: { pattern: 'needle', path: tmpDir, output_mode: 'content' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('outside git');
    expect(result.output).not.toContain('inside git');
  });

  it('native tools advertise a non-trivial approvalRule', () => {
    const read = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const readExec = expectRunnable(read.resolveExecution({ path: join(tmpDir, 'x.txt') }));
    expect(readExec.approvalRule).not.toBe('auto-approve');

    const bash = new NativeBashTool(makeKaos(), tmpDir, createBackgroundManager().manager);
    const bashExec = expectRunnable(bash.resolveExecution({ command: 'echo hi' }));
    expect(bashExec.approvalRule).not.toBe('auto-approve');

    const grep = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const grepExec = expectRunnable(grep.resolveExecution({ pattern: 'x' }));
    expect(grepExec.approvalRule).not.toBe('auto-approve');
  });

  it('reads a file with CRLF line endings', async () => {
    writeFileSync(join(tmpDir, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\n');

    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read_crlf',
      args: { path: join(tmpDir, 'crlf.txt') },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('line1');
    expect(result.output).toContain('line2');
    expect(result.output).toContain('line3');
    expect(result.output).toContain('<system>');
  });

  it('writes a file in append mode', async () => {
    writeFileSync(join(tmpDir, 'append.txt'), 'hello ');

    const tool = new NativeWriteTool(makeKaos(), workspace, 'Write a file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_write_append',
      args: { path: join(tmpDir, 'append.txt'), content: 'world', mode: 'append' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Appended');
    expect(result.output).toContain('5 bytes');
  });

  it('edit fails on non-unique match without replace_all', async () => {
    writeFileSync(join(tmpDir, 'nonunique.txt'), 'aaa aaa aaa');

    const tool = new NativeEditTool(makeKaos(), workspace, 'Edit a file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_edit_nonunique',
      args: {
        path: join(tmpDir, 'nonunique.txt'),
        old_string: 'aaa',
        new_string: 'bbb',
      },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not unique');
  });

  it('edit fails on empty old_string', async () => {
    writeFileSync(join(tmpDir, 'empty.txt'), 'hello');

    const tool = new NativeEditTool(makeKaos(), workspace, 'Edit a file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_edit_empty',
      args: {
        path: join(tmpDir, 'empty.txt'),
        old_string: '',
        new_string: 'bbb',
      },
      signal,
    });

    expect(result.isError).toBe(true);
  });

  it('grep with context lines', async () => {
    writeFileSync(join(tmpDir, 'context.txt'), 'line1\nline2\nneedle\nline4\nline5');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep_ctx',
      args: { pattern: 'needle', path: join(tmpDir, 'context.txt'), output_mode: 'content', '-C': 1 },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('needle');
    expect(result.output).toContain('line2');
    expect(result.output).toContain('line4');
  });

  it('grep with glob filter', async () => {
    writeFileSync(join(tmpDir, 'match.txt'), 'needle in txt');
    writeFileSync(join(tmpDir, 'match.log'), 'needle in log');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep_glob',
      args: { pattern: 'needle', path: tmpDir, output_mode: 'content', glob: '*.txt' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('needle in txt');
    expect(result.output).not.toContain('needle in log');
  });

  it('glob with brace expansion', async () => {
    writeFileSync(join(tmpDir, 'file.ts'), '');
    writeFileSync(join(tmpDir, 'file.tsx'), '');
    writeFileSync(join(tmpDir, 'file.py'), '');

    const tool = new NativeGlobTool(makeKaos(), workspace, 'Find files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_glob_brace',
      args: { pattern: '*.{ts,tsx}', path: tmpDir },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('file.ts');
    expect(result.output).toContain('file.tsx');
    expect(result.output).not.toContain('file.py');
  });

  it('glob with include_dirs=false', async () => {
    mkdirSync(join(tmpDir, 'subdir'), { recursive: true });
    writeFileSync(join(tmpDir, 'file.txt'), '');

    const tool = new NativeGlobTool(makeKaos(), workspace, 'Find files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_glob_no_dirs',
      args: { pattern: '*', path: tmpDir, include_dirs: false },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('file.txt');
    expect(result.output).not.toContain('subdir');
  });

  it('read reports directory as error', async () => {
    mkdirSync(join(tmpDir, 'dir'), { recursive: true });

    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read_dir',
      args: { path: join(tmpDir, 'dir') },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not a file');
  });

  it('read reports binary file as error', async () => {
    writeFileSync(join(tmpDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read_bin',
      args: { path: join(tmpDir, 'binary.bin') },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not readable');
  });
});
