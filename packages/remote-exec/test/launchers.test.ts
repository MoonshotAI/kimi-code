import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { commandLauncherEnv, resolveLauncher, resolveProgramPath } from '../src/client/launchers';

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
        `~'/.kimi-code/bin/kimi' 'exec-server' '--listen' 'stdio'`,
      ],
    });
  });

  it('lowers ssh with a custom remoteBin', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '/opt/kimi/bin/kimi' });
    expect(resolved.args.at(-1)).toBe(`'/opt/kimi/bin/kimi' 'exec-server' '--listen' 'stdio'`);
  });

  it('lowers docker with and without a context', () => {
    expect(resolveLauncher({ type: 'docker', container: 'myapp' }).args).toEqual([
      'exec',
      '-i',
      'myapp',
      '~/.kimi-code/bin/kimi',
      'exec-server',
      '--listen',
      'stdio',
    ]);
    expect(
      resolveLauncher({ type: 'docker', container: 'myapp', context: 'orbstack', remoteBin: '/root/.kimi-code/bin/kimi' }).args,
    ).toEqual([
      '--context',
      'orbstack',
      'exec',
      '-i',
      'myapp',
      '/root/.kimi-code/bin/kimi',
      'exec-server',
      '--listen',
      'stdio',
    ]);
  });

  it('lowers command launchers through PATH resolution with a scrubbed environment', () => {
    const resolved = resolveLauncher({
      type: 'command',
      program: process.execPath,
      args: ['run', 'this'],
      env: { SANDBOX_TOKEN: 'x' },
    });
    expect(resolved.program).toBe(process.execPath);
    expect(resolved.args).toEqual(['run', 'this']);
    expect(resolved.env?.['SANDBOX_TOKEN']).toBe('x');
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
      `~'/bin/kimi' 'exec-server' '--listen' 'stdio'`,
    );
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~deploy/bin/kimi' }).args.at(-1)).toBe(
      `~deploy'/bin/kimi' 'exec-server' '--listen' 'stdio'`,
    );
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~' }).args.at(-1)).toBe(
      `~ 'exec-server' '--listen' 'stdio'`,
    );
  });

  it('quotes a tilde lookalike that is not a valid tilde prefix', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~;id' });
    expect(resolved.args.at(-1)).toBe(`'~;id' 'exec-server' '--listen' 'stdio'`);
  });

  it('escapes single quotes inside remoteBin', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: `/opt/it's/kimi` });
    expect(resolved.args.at(-1)).toBe(`'/opt/it'\\''s/kimi' 'exec-server' '--listen' 'stdio'`);
  });
});

describe('command launcher environment', () => {
  it('keeps only the base whitelist plus the declaration env', () => {
    const baseEnv = {
      PATH: '/usr/bin',
      HOME: '/home/test',
      LANG: 'en_US.UTF-8',
      LC_TIME: 'C',
      KIMI_TEST_LLM_KEY: 'secret',
      SANDBOX_INJECTED: 'nope',
    };
    const env = commandLauncherEnv({ CUSTOM: '1', PATH: '/custom/bin' }, baseEnv);
    expect(env).toEqual({
      PATH: '/custom/bin',
      HOME: '/home/test',
      LANG: 'en_US.UTF-8',
      LC_TIME: 'C',
      CUSTOM: '1',
    });
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

  it('resolves a bare name to an absolute PATH hit', () => {
    expect(resolveProgramPath('sandbox', { cwd: cwdDir, pathEnv: pathDir })).toBe(
      join(pathDir, 'sandbox'),
    );
  });

  it('rejects programs that are not found or not executable', () => {
    expect(() => resolveProgramPath('missing-tool', { cwd: cwdDir, pathEnv: pathDir })).toThrow(
      /not found on PATH/,
    );
    expect(() => resolveProgramPath('not-executable', { cwd: cwdDir, pathEnv: pathDir })).toThrow(
      /not found on PATH/,
    );
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
  });

  it('refuses relative program paths and cwd-local absolute paths', () => {
    expect(() => resolveProgramPath('./sandbox', { cwd: cwdDir, pathEnv: pathDir })).toThrow(
      /must be an absolute path/,
    );
    expect(() =>
      resolveProgramPath(join(cwdDir, 'smuggled'), { cwd: cwdDir, pathEnv: pathDir }),
    ).toThrow(/refusing cwd match/);
  });

  it('accepts an absolute program path outside the working directory', () => {
    expect(resolveProgramPath(join(pathDir, 'sandbox'), { cwd: cwdDir, pathEnv: '' })).toBe(
      join(pathDir, 'sandbox'),
    );
  });
});
