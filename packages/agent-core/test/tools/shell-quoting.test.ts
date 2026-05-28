import { Readable, type Writable } from 'node:stream';

import type { Environment, KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { BashInputSchema, BashTool } from '../../src/tools/builtin/shell/bash';
import { executeTool } from './fixtures/execute-tool';
import { createFakeKaos } from './fixtures/fake-kaos';

const linuxEnv: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
};

const windowsBashEnv: Environment = {
  osKind: 'Windows',
  osArch: 'x86_64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellName: 'bash',
};

function fakeProcess(): KaosProcess {
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 321,
    exitCode: 0,
    wait: vi.fn(async () => 0),
    kill: vi.fn(async () => {}),
  };
}

const signal = new AbortController().signal;

function captureCommandRewrite(
  env: Environment,
  command: string,
): Promise<{ rewritten: string; argv: readonly string[] }> {
  const execWithEnv = vi.fn().mockResolvedValue(fakeProcess());
  const cwd = env.osKind === 'Windows' ? 'C:\\work' : '/work';
  const tool = new BashTool(createFakeKaos({ execWithEnv }), cwd, env);

  return executeTool(tool, {
    turnId: '0',
    toolCallId: 'tc_quote',
    args: { command, timeout: 1000 },
    signal,
  }).then(() => {
      const argv = execWithEnv.mock.calls[0]?.[0] as readonly string[];
      // The shell wrapper is "cd '<cwd>' && <rewritten>"; isolate the rewrite.
      const wrapped = argv[2]!;
      const match = /^cd '[^']+' && (.*)$/.exec(wrapped)!;
      return { rewritten: match[1]!, argv };
    });
}

// Helpers above test the same defensive rewrite the standalone util tests
// exercise: the windows-only nul redirect rewrite must survive composition
// inside the BashTool argv pipeline.
describe('shell command nul-redirect rewrite (Windows Git Bash)', () => {
  it.each([
    ['ls >nul', 'ls >/dev/null'],
    ['ls > NUL', 'ls > /dev/null'],
    ['ls 2>nul', 'ls 2>/dev/null'],
    ['ls &>nul', 'ls &>/dev/null'],
    ['ls >>nul', 'ls >>/dev/null'],
    ['ls >Nul', 'ls >/dev/null'],
    ['ls >NUL', 'ls >/dev/null'],
    ['ls 2>nul | grep foo', 'ls 2>/dev/null | grep foo'],
    ['ls 2>nul; echo done', 'ls 2>/dev/null; echo done'],
    ['ls 2>nul && echo ok', 'ls 2>/dev/null && echo ok'],
    ['ls 2>nul) ', 'ls 2>/dev/null) '],
    ['ls 2>  nul', 'ls 2>  /dev/null'],
    ['foo >nul; bar 2>nul', 'foo >/dev/null; bar 2>/dev/null'],
  ])('rewrites %s', async (before, after) => {
    const { rewritten } = await captureCommandRewrite(windowsBashEnv, before);
    expect(rewritten).toBe(after);
  });
});

describe('shell command nul-redirect non-rewrites (Windows Git Bash)', () => {
  it.each([
    'ls >null',
    'ls >nullable',
    'ls >nul.txt',
    'cat nul.txt',
    'echo nul',
    "echo 'nul'",
    'ls > nul_file',
    'ls >nulX',
  ])('leaves %s unchanged', async (command) => {
    const { rewritten } = await captureCommandRewrite(windowsBashEnv, command);
    expect(rewritten).toBe(command);
  });

  it('does not rewrite quoted >nul with trailing double-quote', async () => {
    const command = 'echo ">nul"';
    const { rewritten } = await captureCommandRewrite(windowsBashEnv, command);
    expect(rewritten).toBe(command);
  });
});

describe('shell command unchanged paths (Windows Git Bash)', () => {
  it('passes a plain command through untouched', async () => {
    const command = 'git status && git diff';
    const { rewritten } = await captureCommandRewrite(windowsBashEnv, command);
    expect(rewritten).toBe(command);
  });

  // The rewrite helper is not exported, so the empty-command contract is
  // only observable at the schema boundary: BashInputSchema rejects ''
  // before the rewrite is ever invoked.
  it('rejects empty command at the schema layer', () => {
    expect(BashInputSchema.safeParse({ command: '' }).success).toBe(false);
  });
});

describe('shell command nul-redirect — non-Windows passthrough', () => {
  it.each([
    'ls >nul',
    'ls 2>nul',
    'ls &>nul',
    'ls >>nul',
    'foo >nul; bar 2>nul',
  ])('does not rewrite %s on Linux', async (command) => {
    const { rewritten } = await captureCommandRewrite(linuxEnv, command);
    expect(rewritten).toBe(command);
  });
});
