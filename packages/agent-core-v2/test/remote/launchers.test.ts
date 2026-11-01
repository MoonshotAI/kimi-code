import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolveProgramPath } from '#/environment/programPath';

import { resolveLauncher } from '#/remote/client/launchers';

describe('launcher lowering', () => {
  it('lowers ssh to the fixed argv shape', () => {
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box' })).toEqual({
      program: 'ssh',
      args: [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'StrictHostKeyChecking=accept-new',
        'dev-box',
        `"$HOME"'/.kimi-code/bin/kimi' 'exec-server' '--listen' 'stdio'`,
      ],
    });
  });

  it('enables one password prompt only for the interactive retry', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box' }, true);
    expect(resolved.args).toEqual([
      '-T',
      '-o',
      'BatchMode=no',
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=accept-new',
      'dev-box',
      `"$HOME"'/.kimi-code/bin/kimi' 'exec-server' '--listen' 'stdio'`,
    ]);
  });
});

describe('launcher operand validation', () => {
  it('rejects an ssh host that would be parsed as an option', () => {
    expect(() => resolveLauncher({ type: 'ssh', host: '-oProxyCommand=./pwn' })).toThrow(
      /ssh host must not start with '-'/,
    );
    expect(() => resolveLauncher({ type: 'ssh', host: '' })).toThrow(/ssh host must not be empty/);
  });

  it('rejects a docker container that would be parsed as a flag', () => {
    expect(() => resolveLauncher({ type: 'docker', container: '-v' })).toThrow(
      /docker container must not start with '-'/,
    );
    expect(() => resolveLauncher({ type: 'docker', container: '' })).toThrow(
      /docker container must not be empty/,
    );
  });
});

describe('ssh remote command quoting', () => {
  it('quotes shell metacharacters in remoteBin against remote re-parsing', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '/opt/$(whoami)/kimi' });
    expect(resolved.args.at(-1)).toBe(`'/opt/$(whoami)/kimi' 'exec-server' '--listen' 'stdio'`);
  });

  it('keeps tilde prefixes expandable while quoting the remainder', () => {
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~/bin/kimi' }).args.at(-1)).toBe(
      `"$HOME"'/bin/kimi' 'exec-server' '--listen' 'stdio'`,
    );
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~/bin dir/kimi' }).args.at(-1)).toBe(
      `"$HOME"'/bin dir/kimi' 'exec-server' '--listen' 'stdio'`,
    );
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~deploy/bin/kimi' }).args.at(-1)).toBe(
      `~deploy/'bin/kimi' 'exec-server' '--listen' 'stdio'`,
    );
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~' }).args.at(-1)).toBe(
      `"$HOME" 'exec-server' '--listen' 'stdio'`,
    );
  });

  it('escapes single quotes inside remoteBin', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: `/opt/it's/kimi` });
    expect(resolved.args.at(-1)).toBe(`'/opt/it'\\''s/kimi' 'exec-server' '--listen' 'stdio'`);
  });
});

describe('ssh remote command tilde expansion through a local shell', () => {
  function expandBinWord(command: string): string {
    const binWord = command.split(' ')[0]!;
    return execFileSync('sh', ['-c', `printf '%s' ${binWord}`], { encoding: 'utf8' });
  }

  it('expands the default remoteBin via $HOME', () => {
    const command = resolveLauncher({ type: 'ssh', host: 'dev-box' }).args.at(-1)!;
    expect(expandBinWord(command)).toBe(`${process.env['HOME']}/.kimi-code/bin/kimi`);
  });

  it('expands a ~user remoteBin via tilde expansion', () => {
    const username = userInfo().username;
    const command = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: `~${username}/bin/kimi` }).args.at(-1)!;
    expect(expandBinWord(command)).toBe(`${userInfo().homedir}/bin/kimi`);
  });
});

describe('command launcher environment', () => {
  it('resolves a bare command against the configured PATH', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'remote-exec-configured-path-'));
    try {
      await writeFile(join(sandbox, 'sandbox'), '#!/bin/sh\nexit 0\n');
      await chmod(join(sandbox, 'sandbox'), 0o755);
      const resolved = resolveLauncher({
        type: 'command',
        program: 'sandbox',
        env: { PATH: sandbox },
      });
      expect(resolved.program).toBe(join(sandbox, 'sandbox'));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('drops host secrets from the resolved command launcher env', () => {
    vi.stubEnv('REMOTE_EXEC_TEST_LLM_KEY', 'secret');
    try {
      const resolved = resolveLauncher({ type: 'command', program: process.execPath });
      expect(resolved.env?.['REMOTE_EXEC_TEST_LLM_KEY']).toBeUndefined();
      expect(resolved.env?.['PATH']).toBe(process.env['PATH']);
      expect(resolved.env?.['HOME']).toBe(process.env['HOME']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('command launcher executor invocation', () => {
  it('appends the default remoteBin and exec-server after the transport args', () => {
    const resolved = resolveLauncher({ type: 'command', program: process.execPath, args: ['ssh', 'i-1', '--'] });
    expect(resolved.args).toEqual(['ssh', 'i-1', '--', '~/.kimi-code/bin/kimi', 'exec-server']);
  });

  it('appends a configured remoteBin', () => {
    const resolved = resolveLauncher({
      type: 'command',
      program: process.execPath,
      args: ['exec', '-i', 'dev-pod', '--'],
      remoteBin: '/root/.kimi-code/bin/kimi',
    });
    expect(resolved.args).toEqual(['exec', '-i', 'dev-pod', '--', '/root/.kimi-code/bin/kimi', 'exec-server']);
  });

  it('appends to an empty argv', () => {
    expect(resolveLauncher({ type: 'command', program: process.execPath }).args).toEqual([
      '~/.kimi-code/bin/kimi',
      'exec-server',
    ]);
  });

  it.each([
    [['ssh', 'i-1', '--', '/opt/kimi', 'exec-server']],
    [['ssh', 'i-1', '--', '/opt/kimi', 'exec-server', '--listen', 'stdio']],
    [['compute', 'ssh', 'dev-vm', '--command', '~/.kimi-code/bin/kimi exec-server']],
    [['compute', 'ssh', 'dev-vm', '--command=~/.kimi-code/bin/kimi exec-server']],
  ])('leaves argv that already invokes exec-server untouched: %j', (args) => {
    expect(resolveLauncher({ type: 'command', program: process.execPath, args, remoteBin: '/ignored' }).args).toEqual(args);
  });

  it('does not mistake an operand that merely contains exec-server for an invocation', () => {
    const resolved = resolveLauncher({ type: 'command', program: process.execPath, args: ['ssh', 'my-exec-server-01', '--'] });
    expect(resolved.args.slice(-2)).toEqual(['~/.kimi-code/bin/kimi', 'exec-server']);
  });

  it('rejects a remoteBin that would read as an option', () => {
    expect(() => resolveLauncher({ type: 'command', program: process.execPath, remoteBin: '--version' })).toThrow(
      "remote bin must not start with '-'",
    );
  });
});

describe('command program PATH resolution', () => {
  let sandbox: string;
  let pathDir: string;
  let cwdDir: string;

  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'remote-exec-path-'));
    pathDir = join(sandbox, 'path-dir');
    cwdDir = join(sandbox, 'cwd-dir');
    await mkdir(pathDir);
    await mkdir(cwdDir);
    await writeFile(join(pathDir, 'sandbox'), '#!/bin/sh\nexit 0\n');
    await chmod(join(pathDir, 'sandbox'), 0o755);
    await writeFile(join(pathDir, 'not-executable'), 'x');
    await chmod(join(pathDir, 'not-executable'), 0o644);
    await writeFile(join(cwdDir, 'smuggled'), '#!/bin/sh\nexit 0\n');
    await chmod(join(cwdDir, 'smuggled'), 0o755);
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it.each(['sandbox', 'sandbox.exe', 'sandbox.EXE'])('resolves Windows launcher %s without doubling its extension', async (program) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    await writeFile(join(pathDir, 'sandbox.exe'), 'executable');
    await chmod(join(pathDir, 'sandbox.exe'), 0o755);
    await writeFile(join(pathDir, 'sandbox.EXE'), 'executable');
    await chmod(join(pathDir, 'sandbox.EXE'), 0o755);
    vi.stubEnv('PATHEXT', '.EXE;.CMD');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(resolveProgramPath(program, { cwd: cwdDir, pathEnv: pathDir }).toLowerCase()).toBe(join(pathDir, 'sandbox.exe').toLowerCase());
      expect(() => resolveProgramPath(program, { cwd: pathDir, pathEnv: pathDir })).toThrow(/refusing cwd match/);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      vi.unstubAllEnvs();
    }
  });

  it('skips relative PATH entries', () => {
    expect(resolveProgramPath('sandbox', { cwd: cwdDir, pathEnv: `relative:${pathDir}` })).toBe(
      join(pathDir, 'sandbox'),
    );
  });

  it('refuses a PATH hit inside the working directory', () => {
    expect(() => resolveProgramPath('smuggled', { cwd: cwdDir, pathEnv: cwdDir })).toThrow(
      /refusing cwd match/,
    );
    expect(() => resolveProgramPath('./sandbox', { cwd: cwdDir, pathEnv: pathDir })).toThrow(
      /must be an absolute path/,
    );
    expect(() =>
      resolveProgramPath(join(cwdDir, 'smuggled'), { cwd: cwdDir, pathEnv: pathDir }),
    ).toThrow(/refusing cwd match/);
  });
});
