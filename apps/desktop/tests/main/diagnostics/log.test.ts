import { describe, it, expect, beforeEach, afterAll, afterEach, vi, type MockInstance } from 'vitest';
import { access, mkdtemp, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initMainLogging,
  defaultMainLogPath,
  isUndiciStreamCloseRace,
  launchId,
  logLaunchBanner,
  logStartup,
  onStartupStep,
  recentLogLines,
  startupTimeline,
  logsDir,
  addDiagnosticRoot,
  diagnosticRoots,
  redactUrlForLog,
  tildify,
  writeLog,
  log,
} from '../../../src/main/diagnostics/log';

const showErrorBox = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  dialog: { showErrorBox },
  app: { getVersion: () => '1.2.3-canary.20261029', isPackaged: true, getLocale: () => 'en-US' },
}));

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
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}\[m\d+\] hello main$/);
    expect(lines[1]).toMatch(/ WARN {2}\[m\d+\] careful$/);
  });

  it('appends the error stack for log.error(message, error)', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    log.error('boom happened', new Error('kaput'));
    const content = await readFile(path, 'utf-8');
    expect(content).toMatch(/ERROR {2}\[m\d+\] boom happened {2}Error: kaput/);
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
      log.info(`${i}${chunk}`);
    }
    expect((await stat(`${path}.1`)).size).toBeGreaterThan(5 * 1024 * 1024);
    const current = await stat(path);
    expect(current.size).toBeLessThan(1024 * 1024 * 2);
  });

  it('shifts older generations and keeps at most five rotated files', async () => {
    const path = await freshLogPath();
    await writeFile(path, Buffer.alloc(SIX_MIB, 'c'));
    for (let generation = 1; generation <= 5; generation += 1) {
      await writeFile(`${path}.${generation}`, `generation-${generation}`);
    }
    initMainLogging(path);
    expect((await stat(`${path}.1`)).size).toBe(SIX_MIB);
    for (let generation = 2; generation <= 5; generation += 1) {
      expect(await readFile(`${path}.${generation}`, 'utf-8')).toBe(`generation-${generation - 1}`);
    }
    await expect(access(`${path}.6`)).rejects.toThrow();
  });

  it('re-reads the real size before rotating so a file another process just rotated is kept', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    const chunk = 'z'.repeat(1024 * 1024);
    for (let i = 0; i < 4; i += 1) log.info(`a${i}${chunk}`);
    await rename(path, `${path}.1`);
    for (let i = 0; i < 2; i += 1) log.info(`b${i}${chunk}`);
    await expect(access(`${path}.2`)).rejects.toThrow();
    expect((await stat(path)).size).toBeLessThan(3 * 1024 * 1024);
    expect((await readFile(`${path}.1`, 'utf-8')).startsWith(`${new Date().getUTCFullYear()}`)).toBe(true);
  });

  it('tags lines with the caller-provided source', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    writeLog('warn', 'from the renderer', 'r4242');
    expect(await readFile(path, 'utf-8')).toMatch(/ WARN {2}\[r4242\] from the renderer\n$/);
  });

  it('remembers every folder diagnostics were written to, current home first', async () => {
    const first = await freshLogPath();
    const second = await freshLogPath();
    initMainLogging(first);
    initMainLogging(second);
    addDiagnosticRoot(join(first, '..'));
    const roots = diagnosticRoots();
    expect(roots[0]).toBe(logsDir());
    expect(roots).toEqual(expect.arrayContaining([join(first, '..'), join(second, '..')]));
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe('repeated lines', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('folds consecutive duplicates into one summary line', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    for (let i = 0; i < 4; i += 1) log.warn('same failure');
    log.info('different line');
    const lines = (await readFile(path, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/WARN {2}\[m\d+\] same failure$/);
    expect(lines[1]).toMatch(/WARN {2}\[m\d+\] previous line repeated 3 more times$/);
    expect(lines[2]).toMatch(/INFO {2}\[m\d+\] different line$/);
  });

  it('keeps lines from different sources apart', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    writeLog('info', 'shared text', 'r1');
    writeLog('info', 'shared text', 'r2');
    log.info('end of source test');
    const lines = (await readFile(path, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('writes the summary when the burst ends without another line', async () => {
    vi.useFakeTimers();
    const path = await freshLogPath();
    initMainLogging(path);
    log.error('burst start');
    log.error('burst');
    log.error('burst');
    vi.advanceTimersByTime(60_000);
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('previous line repeated 1 more time\n');
    log.info('end of burst test');
  });

  it('writes a duplicate again once the window has passed', async () => {
    vi.useFakeTimers();
    const path = await freshLogPath();
    initMainLogging(path);
    log.info('periodic');
    vi.advanceTimersByTime(61_000);
    log.info('periodic');
    log.info('end of window test');
    const lines = (await readFile(path, 'utf-8')).trim().split('\n');
    expect(lines.filter((line) => line.endsWith('periodic'))).toHaveLength(2);
  });
});

describe('startup and launch lines', () => {
  it('stamps startup steps with the process uptime', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    logStartup('server-ready', 'took=12ms');
    logStartup('window-created');
    const lines = (await readFile(path, 'utf-8')).trim().split('\n');
    expect(lines[0]).toMatch(/\[startup\] server-ready at=\+\d+ms took=12ms$/);
    expect(lines[1]).toMatch(/\[startup\] window-created at=\+\d+ms$/);
  });

  it('writes a launch banner with version, channel, platform and the log location', async () => {
    const path = await freshLogPath();
    initMainLogging(path);
    logLaunchBanner();
    const content = await readFile(path, 'utf-8');
    expect(content).toContain(`[launch] version=1.2.3-canary.20261029 channel=canary launch=${launchId()}`);
    expect(launchId()).toMatch(/^[0-9a-f]{12}$/);
    expect(content).toContain(`arch=${process.arch}`);
    expect(content).toContain(`log=${tildify(path)}`);
  });
});

describe('startup steps and recent lines', () => {
  it('notifies listeners, keeps a timeline and survives a failing listener', async () => {
    initMainLogging(await freshLogPath());
    const seen: string[] = [];
    const stopFailing = onStartupStep(() => {
      throw new Error('listener broke');
    });
    const stop = onStartupStep((entry) => seen.push(`${entry.step}:${entry.details ?? ''}`));
    logStartup('boot-sessions');
    logStartup('connect-failed', 'stage=load_url');
    stop();
    stopFailing();
    logStartup('ui-ready');
    expect(seen).toEqual(['boot-sessions:', 'connect-failed:stage=load_url']);
    expect(startupTimeline().slice(-3).map((entry) => entry.step)).toEqual(['boot-sessions', 'connect-failed', 'ui-ready']);
    expect(recentLogLines().join('')).toContain('[startup] listener failed: listener broke');
  });

  it('keeps only the most recent lines in memory', async () => {
    initMainLogging(await freshLogPath());
    for (let i = 0; i < 250; i += 1) log.info(`ring line ${i}`);
    const lines = recentLogLines();
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)).toContain('ring line 249');
    expect(lines.join('')).not.toContain('ring line 49\n');
  });
});

describe('defaultMainLogPath', () => {
  it('lives under <KIMI_CODE_HOME>/logs', () => {
    const prev = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/tmp/kimi-home-test';
    try {
      expect(logsDir()).toBe(join('/tmp/kimi-home-test', 'logs'));
      expect(defaultMainLogPath()).toBe(join('/tmp/kimi-home-test', 'logs', 'kimi-code-desktop.log'));
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

  it('collapses inline data: pages instead of logging their markup', () => {
    expect(redactUrlForLog('data:text/html;charset=utf-8,%3Ch1%3Eboom%3C%2Fh1%3E')).toBe('data:(inline page)');
  });
});

describe('tildify', () => {
  it('shortens paths under the home directory only', () => {
    expect(tildify(join(homedir(), '.kimi-code', 'logs'))).toBe(join('~', '.kimi-code', 'logs'));
    expect(tildify(homedir())).toBe('~');
    expect(tildify(`${homedir()}-other/logs`)).toBe(`${homedir()}-other/logs`);
    expect(tildify('/var/log/system.log')).toBe('/var/log/system.log');
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
  it('swallows stdio errors so a dead dev console cannot cascade into the crash dialog', async () => {
    vi.resetModules();
    const stdioHandlers = new Map<string, (error: unknown) => void>();
    const stdoutOnSpy = vi.spyOn(process.stdout, 'on').mockImplementation(((event: string, cb: (error: unknown) => void) => {
      stdioHandlers.set(`stdout:${event}`, cb);
      return process.stdout;
    }) as unknown as typeof process.stdout.on);
    const stderrOnSpy = vi.spyOn(process.stderr, 'on').mockImplementation(((event: string, cb: (error: unknown) => void) => {
      stdioHandlers.set(`stderr:${event}`, cb);
      return process.stderr;
    }) as unknown as typeof process.stderr.on);
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation((() => process) as unknown as typeof process.on);
    try {
      const { installCrashGuards, log: freshLog } = await import('../../../src/main/diagnostics/log');
      installCrashGuards();
      for (const code of ['EPIPE', 'EIO', 'EBADF']) {
        const error = Object.assign(new Error(`write ${code}`), { code });
        expect(() => stdioHandlers.get('stdout:error')?.(error)).not.toThrow();
        expect(() => stdioHandlers.get('stderr:error')?.(error)).not.toThrow();
      }
      freshLog.info('after-dead-console');
      expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('after-dead-console'));
    } finally {
      stdoutOnSpy.mockRestore();
      stderrOnSpy.mockRestore();
      processOnSpy.mockRestore();
    }
  });

  it('stops mirroring to the console when a write throws synchronously', async () => {
    vi.resetModules();
    stdoutSpy.mockImplementation(() => {
      throw Object.assign(new Error('write EIO'), { code: 'EIO' });
    });
    const { log: freshLog } = await import('../../../src/main/diagnostics/log');
    expect(() => freshLog.info('first')).not.toThrow();
    stdoutSpy.mockClear();
    stdoutSpy.mockImplementation(() => true);
    freshLog.info('second');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('tracks app_crashed for uncaught errors and skips the benign undici race', async () => {
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
      const { setDesktopTrackImpl } = await import('../../../src/main/diagnostics/track');
      const { installCrashGuards } = await import('../../../src/main/diagnostics/log');
      setDesktopTrackImpl(impl);
      installCrashGuards();

      handlers.get('uncaughtException')?.(new TypeError('x'));
      expect(impl).toHaveBeenCalledWith('app_crashed', {
        process: 'main',
        kind: 'uncaught_exception',
        error_name: 'TypeError',
        app_uptime_ms: expect.any(Number),
        fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
        top_frame: expect.stringMatching(/^log\.test\.ts:\d+:\d+$/),
      });

      handlers.get('unhandledRejection')?.('oops');
      expect(impl).toHaveBeenCalledWith('app_crashed', {
        process: 'main',
        kind: 'unhandled_rejection',
        error_name: undefined,
        app_uptime_ms: expect.any(Number),
        fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
        top_frame: undefined,
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

  function captureProcessHandlers(): { handlers: Map<string, (arg: unknown) => void>; restore: () => void } {
    const handlers = new Map<string, (arg: unknown) => void>();
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(((event: string, cb: (arg: unknown) => void) => {
        handlers.set(event, cb);
        return process;
      }) as unknown as typeof process.on);
    return { handlers, restore: () => onSpy.mockRestore() };
  }

  it('shows a single dialog for errors raised before the main window exists', async () => {
    vi.resetModules();
    const { handlers, restore } = captureProcessHandlers();
    try {
      showErrorBox.mockClear();
      const { installCrashGuards } = await import('../../../src/main/diagnostics/log');
      installCrashGuards();

      handlers.get('uncaughtException')?.(new Error('startup broke'));
      handlers.get('unhandledRejection')?.(new Error('startup broke again'));

      expect(showErrorBox).toHaveBeenCalledOnce();
      expect(showErrorBox).toHaveBeenCalledWith(
        'A JavaScript error occurred in the main process',
        expect.stringContaining('startup broke'),
      );
    } finally {
      restore();
    }
  });

  it('stays silent once the main window exists unless a notice is registered, which fires once', async () => {
    vi.resetModules();
    const { handlers, restore } = captureProcessHandlers();
    try {
      showErrorBox.mockClear();
      const { installCrashGuards, logStartup, setUncaughtErrorNotice } = await import('../../../src/main/diagnostics/log');
      installCrashGuards();
      logStartup('window-created');

      handlers.get('uncaughtException')?.(new Error('quietly logged'));
      expect(showErrorBox).not.toHaveBeenCalled();

      const notice = vi.fn();
      setUncaughtErrorNotice(notice);
      handlers.get('unhandledRejection')?.(new Error('noticed'));
      handlers.get('uncaughtException')?.(new Error('not noticed again'));

      expect(notice).toHaveBeenCalledOnce();
      expect(notice).toHaveBeenCalledWith({
        title: 'A JavaScript error occurred in the main process',
        detail: expect.stringContaining('noticed'),
      });
      expect(showErrorBox).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
