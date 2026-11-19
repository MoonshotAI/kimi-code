import { afterEach, describe, expect, it, vi } from 'vitest';

import { log, setLog } from '#/utils/log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('utils log', () => {
  it('is silent by default', () => {
    setLog();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    log.debug('zeroth');
    log.info({ provider: 'kimi' }, 'first');
    log.warn('second');
    log.error('third');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('routes plain and structured calls through the injected implementation', () => {
    const received: unknown[][] = [];
    setLog({
      debug: (...args) => received.push(['debug', ...args]),
      info: (...args) => received.push(['info', ...args]),
      warn: (...args) => received.push(['warn', ...args]),
      error: (...args) => received.push(['error', ...args]),
    });
    log.debug('plain');
    log.info({ provider: 'kimi', attempt: 2 }, 'structured');
    log.warn('plain warn');
    log.error({ kind: 'provider' }, 'structured error');
    expect(received).toEqual([
      ['debug', 'plain'],
      ['info', { provider: 'kimi', attempt: 2 }, 'structured'],
      ['warn', 'plain warn'],
      ['error', { kind: 'provider' }, 'structured error'],
    ]);
  });

  it('restores the silent default when reset', () => {
    const received: unknown[][] = [];
    setLog({
      debug: () => {},
      info: () => {},
      warn: (...args) => received.push([...args]),
      error: () => {},
    });
    log.warn('before reset');
    setLog();
    log.warn('after reset');
    expect(received).toEqual([['before reset']]);
  });
});
