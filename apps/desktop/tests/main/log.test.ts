import { describe, it, expect, beforeEach, afterAll, vi, type MockInstance } from 'vitest';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initMainLogging,
  defaultMainLogPath,
  isUndiciStreamCloseRace,
  redactUrlForLog,
  log,
} from '../../src/main/log';

// log.ts imports electron for dialog.showErrorBox; under plain vitest the
// package resolves to the executable-path shim, so mock it (same pattern as
// connect.test.ts / preload.test.ts).
vi.mock('electron', () => ({ dialog: { showErrorBox: vi.fn() } }));

const SIX_MIB = 6 * 1024 * 1024;

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

async function freshLogPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-desktop-log-'));
  return join(dir, 'kimi-code-desktop.log');
}

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('initMainLogging + log', () => {
  it('writes ISO-timestamped leveled lines to the file', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    log.info('hello main');
    log.warn('careful');
    const content = await readFile(path, 'utf-8');
    const lines = content.split('\n');
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}hello main$/);
    expect(lines[1]).toMatch(/ WARN {2}careful$/);
  });

  it('appends the error stack for log.error(message, error)', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    log.error('boom happened', new Error('kaput'));
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('ERROR  boom happened  Error: kaput');
    expect(content).toContain('log.test');
  });

  it('mirrors info to stdout and warnings/errors to stderr', async () => {
    initMainLogging(await freshLogPath());
    log.info('to-out');
    log.warn('to-err');
    log.error('also-err');
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('to-out'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('to-err'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('also-err'));
  });

  it('rotates an oversized existing log aside on init', async () => {
    const path = await freshLogPath();
    await writeFile(path, Buffer.alloc(SIX_MIB, 'x'));
    initMainLogging(path);
    expect((await stat(`${path}.1`)).size).toBe(SIX_MIB);
    log.info('fresh start');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('fresh start');
    expect(content).not.toContain('xxx');
  });

  it('rotates live once the file grows past the cap', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    const chunk = 'y'.repeat(1024 * 1024);
    for (let i = 0; i < 6; i += 1) {
      log.info(chunk);
    }
    expect((await stat(`${path}.1`)).size).toBeGreaterThan(5 * 1024 * 1024);
    const current = await stat(path);
    expect(current.size).toBeLessThan(1024 * 1024 * 2);
  });
});

describe('defaultMainLogPath', () => {
  it('lives under <KIMI_CODE_HOME>/logs', () => {
    const prev = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/tmp/kimi-home-test';
    try {
      expect(defaultMainLogPath()).toBe('/tmp/kimi-home-test/logs/kimi-code-desktop.log');
    } finally {
      if (prev === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = prev;
    }
  });
});

describe('redactUrlForLog', () => {
  it('strips basic-auth userinfo, query and fragment', () => {
    expect(redactUrlForLog('http://user:pass@127.0.0.1:58627/api/v1?x=1#frag')).toBe(
      'http://127.0.0.1:58627/api/v1',
    );
  });

  it('strips the server token fragment and origin query from renderer URLs', () => {
    const url =
      'app://renderer/index.html?kimi_desktop=1&kimi_origin=http%3A%2F%2Fuser%3Apass%40127.0.0.1%3A58627#token=secret';
    const out = redactUrlForLog(url);
    expect(out).toBe('app://renderer/index.html');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('pass');
  });

  it('falls back to cutting at ?/# for unparseable values', () => {
    expect(redactUrlForLog('not a url?x=1#f')).toBe('not a url');
  });
});

describe('isUndiciStreamCloseRace', () => {
  function undiciError(): Error {
    return Object.assign(
      new TypeError('Invalid state: ReadableStream is already closed'),
      { code: 'ERR_INVALID_STATE' },
    );
  }

  it('matches the known undici double-close race', () => {
    expect(isUndiciStreamCloseRace(undiciError())).toBe(true);
  });

  it('rejects lookalikes missing the code or the message', () => {
    expect(isUndiciStreamCloseRace(new Error('ReadableStream is already closed'))).toBe(false);
    expect(
      isUndiciStreamCloseRace(
        Object.assign(new Error('Invalid state: something else'), { code: 'ERR_INVALID_STATE' }),
      ),
    ).toBe(false);
    expect(isUndiciStreamCloseRace(new Error('boom'))).toBe(false);
    expect(isUndiciStreamCloseRace('ReadableStream is already closed')).toBe(false);
    expect(isUndiciStreamCloseRace(undefined)).toBe(false);
  });
});

describe('installCrashGuards', () => {
  it('tracks app_crashed for uncaught errors and skips the benign undici race', async () => {
    // Fresh module instances: every initMainLogging() above already tripped
    // the once-only guard installation on the shared instance.
    vi.resetModules();
    const handlers = new Map<string, (arg: unknown) => void>();
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(((event: string, cb: (arg: unknown) => void) => {
        handlers.set(event, cb);
        return process;
      }) as unknown as typeof process.on);
    const impl = vi.fn();
    try {
      const { setDesktopTrackImpl } = await import('../../src/main/track');
      const { installCrashGuards } = await import('../../src/main/log');
      setDesktopTrackImpl(impl);
      installCrashGuards();

      handlers.get('uncaughtException')?.(new TypeError('x'));
      expect(impl).toHaveBeenCalledWith('app_crashed', {
        kind: 'uncaught_exception',
        error_name: 'TypeError',
      });

      handlers.get('unhandledRejection')?.('oops');
      expect(impl).toHaveBeenCalledWith('app_crashed', {
        kind: 'unhandled_rejection',
        error_name: undefined,
      });

      impl.mockClear();
      handlers.get('uncaughtException')?.(
        Object.assign(new TypeError('Invalid state: ReadableStream is already closed'), {
          code: 'ERR_INVALID_STATE',
        }),
      );
      expect(impl).not.toHaveBeenCalled();
    } finally {
      onSpy.mockRestore();
    }
  });
});
