import { afterEach, describe, expect, it, vi } from 'vitest';

import { pidAlive } from '#/agent/task/pidAlive';

function killError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pidAlive', () => {
  it('reports the current process as alive', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('rejects pids that cannot identify a process', () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
    expect(pidAlive(Number.NaN)).toBe(false);
  });

  it('treats ESRCH as dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw killError('ESRCH');
    });

    expect(pidAlive(4242)).toBe(false);
  });

  it('treats EPERM as alive — the process exists but belongs to another user', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw killError('EPERM');
    });

    expect(pidAlive(4242)).toBe(true);
  });

  it('assumes alive on an unrecognised errno rather than clobbering a live task', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw killError('EINVAL');
    });

    expect(pidAlive(4242)).toBe(true);
  });

  it('probes with signal 0 so it never disturbs the target', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(pidAlive(4242)).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });
});
