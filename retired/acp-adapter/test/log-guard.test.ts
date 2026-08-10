import { afterEach, describe, expect, it, vi } from 'vitest';

import { redirectConsoleToStderr } from '../src/log-guard';

describe('redirectConsoleToStderr', () => {
  const restorers: Array<() => void> = [];

  afterEach(() => {
    while (restorers.length > 0) {
      restorers.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it('routes console.log / info / warn to stderr and leaves stdout untouched', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const restore = redirectConsoleToStderr();
    restorers.push(restore);

    console.log('hello-log');
    console.info('hello-info');
    console.warn('hello-warn');

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('hello-log\n');
    expect(stderrSpy).toHaveBeenCalledWith('hello-info\n');
    expect(stderrSpy).toHaveBeenCalledWith('hello-warn\n');
  });

  it('does not redirect console.error (which already targets stderr)', () => {
    const origError = console.error;
    const restore = redirectConsoleToStderr();
    restorers.push(restore);
    expect(console.error).toBe(origError);
  });

  it('restores the original console sinks when the returned function is called', () => {
    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;

    const restore = redirectConsoleToStderr();
    expect(console.log).not.toBe(origLog);
    expect(console.info).not.toBe(origInfo);
    expect(console.warn).not.toBe(origWarn);

    restore();
    expect(console.log).toBe(origLog);
    expect(console.info).toBe(origInfo);
    expect(console.warn).toBe(origWarn);
  });
});
