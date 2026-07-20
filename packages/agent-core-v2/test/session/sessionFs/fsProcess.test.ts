import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { type IProcess, type ISessionProcessRunner } from '#/session/process/processRunner';

import { runCommand, type RunCommandOptions } from '#/session/sessionFs/fsProcess';

interface FakeProcessOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly onKill?: () => void;
}

function fakeProcess(opts: FakeProcessOptions = {}): IProcess {
  return {
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    stdout: Readable.from([opts.stdout ?? '']),
    stderr: Readable.from([opts.stderr ?? '']),
    pid: 1,
    exitCode: opts.exitCode ?? null,
    wait: () => Promise.resolve(opts.exitCode ?? 0),
    kill: () => {
      opts.onKill?.();
      return Promise.resolve();
    },
    dispose: () => undefined,
  };
}

function fakeRunner(proc: IProcess): ISessionProcessRunner {
  return {
    _serviceBrand: undefined,
    exec: () => Promise.resolve(proc),
  };
}

describe('runCommand', () => {
  it('collects stdout, stderr, and exit code', async () => {
    const proc = fakeProcess({ stdout: 'hello', stderr: 'warn', exitCode: 7 });
    const result = await runCommand(fakeRunner(proc), ['echo']);
    expect(result).toEqual({ exitCode: 7, stdout: 'hello', stderr: 'warn' });
  });

  it('passes cwd and env to the runner', async () => {
    let received: { args: readonly string[]; cwd?: string; env?: Record<string, string> } | undefined;
    const runner: ISessionProcessRunner = {
      _serviceBrand: undefined,
      exec: (args, options) => {
        received = { args, cwd: options?.cwd, env: options?.env };
        return Promise.resolve(fakeProcess());
      },
    };
    await runCommand(runner, ['git', 'status'], { cwd: '/repo', env: { FOO: '1' } });
    expect(received).toEqual({ args: ['git', 'status'], cwd: '/repo', env: { FOO: '1' } });
  });

  it('kills the process when the signal is already aborted', async () => {
    let killed = false;
    const proc = fakeProcess({ onKill: () => { killed = true; } });
    const controller = new AbortController();
    controller.abort();
    await runCommand(fakeRunner(proc), ['sleep'], { signal: controller.signal });
    expect(killed).toBe(true);
  });

  it('kills the process when the signal aborts later', async () => {
    let killed = false;
    const proc = fakeProcess({ onKill: () => { killed = true; } });
    const controller = new AbortController();
    const options: RunCommandOptions = { signal: controller.signal };
    const promise = runCommand(fakeRunner(proc), ['sleep'], options);
    controller.abort();
    await promise;
    expect(killed).toBe(true);
  });
});
