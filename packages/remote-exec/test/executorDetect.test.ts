import { describe, expect, it, vi } from 'vitest';

import {
  defaultLocalRunner,
  resolveTildeRemoteBin,
  type LocalRunner,
  type LocalRunRequest,
  type LocalRunResult,
} from '../src/client/executorDetect';
import type { LauncherSpec } from '../src/client/launchers';

const SSH: LauncherSpec & { readonly type: 'ssh' } = { type: 'ssh', host: 'dev-box' };
const DOCKER: LauncherSpec & { readonly type: 'docker' } = { type: 'docker', container: 'myapp-dev' };

function ok(partial: Partial<LocalRunResult> = {}): LocalRunResult {
  return { code: 0, signal: null, stdout: '', stderr: '', ...partial };
}

describe('resolveTildeRemoteBin', () => {
  it('resolves the default tilde remoteBin with one home probe', async () => {
    const requests: LocalRunRequest[] = [];
    const runner: LocalRunner = async (request: LocalRunRequest) => {
      requests.push(request);
      return ok({ stdout: '/root\n' });
    };

    const resolved = await resolveTildeRemoteBin(DOCKER, runner);

    expect(resolved).toEqual({ ...DOCKER, remoteBin: '/root/.kimi-code/bin/kimi' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      program: 'docker',
      args: ['exec', 'myapp-dev', 'sh', '-c', 'printf "%s" "$HOME"'],
    });
  });

  it('resolves a custom tilde-prefixed docker remoteBin against the probed home', async () => {
    const runner: LocalRunner = async () => ok({ stdout: '/home/app' });

    const resolved = await resolveTildeRemoteBin(
      { type: 'docker', container: 'myapp-dev', remoteBin: '~/bin/kimi' },
      runner,
    );

    expect(resolved).toEqual({
      type: 'docker',
      container: 'myapp-dev',
      remoteBin: '/home/app/bin/kimi',
    });
  });

  it('resolves a root home without a doubled slash', async () => {
    const runner: LocalRunner = async () => ok({ stdout: '/' });

    const resolved = await resolveTildeRemoteBin(DOCKER, runner);

    expect(resolved).toEqual({ ...DOCKER, remoteBin: '/.kimi-code/bin/kimi' });
  });

  it('keeps the declared remoteBin when the home probe fails', async () => {
    const runner: LocalRunner = async () => ({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'Error: No such container: myapp-dev',
    });

    expect(await resolveTildeRemoteBin(DOCKER, runner)).toBe(DOCKER);
  });

  it('keeps the declared remoteBin when the probed home is not absolute', async () => {
    const runner: LocalRunner = async () => ok({ stdout: 'relative/home' });

    expect(await resolveTildeRemoteBin(DOCKER, runner)).toBe(DOCKER);
  });

  it('never probes for ssh launchers or an absolute docker remoteBin', async () => {
    const runner = vi.fn() as unknown as LocalRunner;

    expect(await resolveTildeRemoteBin(SSH, runner)).toBe(SSH);
    const absolute: LauncherSpec & { readonly type: 'docker' } = {
      type: 'docker',
      container: 'myapp-dev',
      remoteBin: '/opt/kimi/bin/kimi',
    };
    expect(await resolveTildeRemoteBin(absolute, runner)).toBe(absolute);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('defaultLocalRunner', () => {
  it('escalates to SIGKILL when the child ignores SIGTERM on timeout', async () => {
    const started = Date.now();
    const result = await defaultLocalRunner({
      program: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      timeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('command timed out after 200ms');
  });

  it('resolves with SIGTERM when the child exits on the first signal', async () => {
    const result = await defaultLocalRunner({
      program: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);'],
      timeoutMs: 200,
    });
    expect(result.signal).toBe('SIGTERM');
    expect(result.stderr).toContain('command timed out after 200ms');
  });
});
