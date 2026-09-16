import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveLauncher, resolveProgramPath } from '../src/client/launchers';

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
        '~/.kimi-code/bin/kimi',
        'exec-server',
        '--listen',
        'stdio',
      ],
    });
  });

  it('lowers ssh with a custom remoteBin', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '/opt/kimi/bin/kimi' });
    expect(resolved.args.slice(-4)).toEqual(['/opt/kimi/bin/kimi', 'exec-server', '--listen', 'stdio']);
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

  it('lowers command launchers through PATH resolution', () => {
    const resolved = resolveLauncher({
      type: 'command',
      program: process.execPath,
      args: ['run', 'this'],
      env: { AGI_TOKEN: 'x' },
    });
    expect(resolved).toEqual({
      program: process.execPath,
      args: ['run', 'this'],
      env: { AGI_TOKEN: 'x' },
    });
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
    await writeFile(join(pathDir, 'agi'), '#!/bin/sh\nexit 0\n');
    await chmod(join(pathDir, 'agi'), 0o755);
    await writeFile(join(pathDir, 'not-executable'), 'x');
    await chmod(join(pathDir, 'not-executable'), 0o644);
    await writeFile(join(cwdDir, 'smuggled'), '#!/bin/sh\nexit 0\n');
    await chmod(join(cwdDir, 'smuggled'), 0o755);
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('resolves a bare name to an absolute PATH hit', () => {
    expect(resolveProgramPath('agi', { cwd: cwdDir, pathEnv: pathDir })).toBe(
      join(pathDir, 'agi'),
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
    expect(resolveProgramPath('agi', { cwd: cwdDir, pathEnv: `relative:${pathDir}` })).toBe(
      join(pathDir, 'agi'),
    );
  });

  it('refuses a PATH hit inside the working directory', () => {
    expect(() => resolveProgramPath('smuggled', { cwd: cwdDir, pathEnv: cwdDir })).toThrow(
      /refusing cwd match/,
    );
  });

  it('refuses relative program paths and cwd-local absolute paths', () => {
    expect(() => resolveProgramPath('./agi', { cwd: cwdDir, pathEnv: pathDir })).toThrow(
      /must be an absolute path/,
    );
    expect(() =>
      resolveProgramPath(join(cwdDir, 'smuggled'), { cwd: cwdDir, pathEnv: pathDir }),
    ).toThrow(/refusing cwd match/);
  });

  it('accepts an absolute program path outside the working directory', () => {
    expect(resolveProgramPath(join(pathDir, 'agi'), { cwd: cwdDir, pathEnv: '' })).toBe(
      join(pathDir, 'agi'),
    );
  });
});
