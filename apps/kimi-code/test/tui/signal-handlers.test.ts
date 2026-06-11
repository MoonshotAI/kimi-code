import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';

interface SignalDriver {
  state: TUIState;
  registerSignalHandlers(): void;
  unregisterSignalHandlers(): void;
  emergencyTerminalExit(): never;
  stop(): Promise<void>;
}

function makeStartupInput(): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-signals',
  };
}

function makeHarness() {
  return {
    getConfig: vi.fn(async () => ({})),
    createSession: vi.fn(),
    resumeSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
  };
}

function makeDriver(): { driver: SignalDriver; tui: KimiTUI } {
  const tui = new KimiTUI(makeHarness() as never, makeStartupInput());
  const driver = tui as unknown as SignalDriver;
  return { driver, tui };
}

// Capture handlers via process.prependListener spy so we can invoke them
// directly without going through `process.emit`. Routing through emit also
// fires unrelated listeners that vitest installs on its worker process, and
// those listeners exit the worker.
interface CapturedHandlers {
  signalHandlers: Map<NodeJS.Signals, (...args: unknown[]) => void>;
  stdoutErrorHandler?: (error: Error) => void;
  stderrErrorHandler?: (error: Error) => void;
  restore: () => void;
}

function captureHandlers(driver: SignalDriver): CapturedHandlers {
  const signalHandlers = new Map<NodeJS.Signals, (...args: unknown[]) => void>();
  // The Node typings give `process.prependListener` a long list of overloads
  // (one per signal). We bypass that by typing the spy through `unknown`.
  const prependSpy = vi.spyOn(process, 'prependListener');
  (prependSpy as unknown as { mockImplementation: (fn: unknown) => unknown }).mockImplementation(
    (event: string | symbol, listener: (...args: unknown[]) => void): NodeJS.Process => {
      if (event === 'SIGTERM' || event === 'SIGHUP') {
        signalHandlers.set(event, listener);
      }
      return process;
    },
  );

  let stdoutErrorHandler: ((error: Error) => void) | undefined;
  let stderrErrorHandler: ((error: Error) => void) | undefined;
  const stdoutOnSpy = vi.spyOn(process.stdout, 'on');
  (stdoutOnSpy as unknown as { mockImplementation: (fn: unknown) => unknown }).mockImplementation(
    (event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'error') {
        stdoutErrorHandler = listener as (error: Error) => void;
      }
      return process.stdout;
    },
  );
  const stderrOnSpy = vi.spyOn(process.stderr, 'on');
  (stderrOnSpy as unknown as { mockImplementation: (fn: unknown) => unknown }).mockImplementation(
    (event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'error') {
        stderrErrorHandler = listener as (error: Error) => void;
      }
      return process.stderr;
    },
  );

  driver.registerSignalHandlers();

  return {
    signalHandlers,
    get stdoutErrorHandler() {
      return stdoutErrorHandler;
    },
    get stderrErrorHandler() {
      return stderrErrorHandler;
    },
    restore: () => {
      prependSpy.mockRestore();
      stdoutOnSpy.mockRestore();
      stderrOnSpy.mockRestore();
    },
  } as unknown as CapturedHandlers;
}

describe('KimiTUI signal handlers', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let platformDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    exitSpy.mockRestore();
    if (platformDescriptor !== undefined) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('emergencyTerminalExit exits with code 129', () => {
    const { driver } = makeDriver();
    driver.emergencyTerminalExit();
    expect(exitSpy).toHaveBeenCalledWith(129);
  });

  it('registers SIGTERM and SIGHUP on POSIX, only SIGTERM on Windows', () => {
    // POSIX
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const posix = makeDriver();
    const posixCaptured = captureHandlers(posix.driver);
    expect(posixCaptured.signalHandlers.has('SIGTERM')).toBe(true);
    expect(posixCaptured.signalHandlers.has('SIGHUP')).toBe(true);
    posixCaptured.restore();
    posix.driver.unregisterSignalHandlers();

    // Windows
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const win = makeDriver();
    const winCaptured = captureHandlers(win.driver);
    expect(winCaptured.signalHandlers.has('SIGTERM')).toBe(true);
    expect(winCaptured.signalHandlers.has('SIGHUP')).toBe(false);
    winCaptured.restore();
    win.driver.unregisterSignalHandlers();
  });

  it('SIGHUP handler calls emergencyTerminalExit (process.exit(129)) without going through stop()', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { driver, tui } = makeDriver();
    const stopSpy = vi.spyOn(tui, 'stop').mockResolvedValue(undefined);
    const captured = captureHandlers(driver);

    const sighup = captured.signalHandlers.get('SIGHUP');
    expect(sighup).toBeDefined();
    sighup?.();

    expect(exitSpy).toHaveBeenCalledWith(129);
    expect(stopSpy).not.toHaveBeenCalled();

    stopSpy.mockRestore();
    captured.restore();
    driver.unregisterSignalHandlers();
  });

  it('SIGTERM handler falls back to emergency exit (code 143) when stop() rejects', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { driver, tui } = makeDriver();
    const stopSpy = vi.spyOn(tui, 'stop').mockRejectedValue(new Error('cleanup boom'));
    const captured = captureHandlers(driver);

    const sigterm = captured.signalHandlers.get('SIGTERM');
    expect(sigterm).toBeDefined();
    sigterm?.();

    // Allow the rejected stop() promise to settle so the .catch() chain runs.
    await Promise.resolve();
    await Promise.resolve();

    // 143 = 128 + SIGTERM(15). Supervisors key off this to detect signal-driven
    // exits; we must not collapse it to the SIGHUP code (129) or to 0.
    expect(stopSpy).toHaveBeenCalledWith(143);
    expect(exitSpy).toHaveBeenCalledWith(143);
    expect(exitSpy).not.toHaveBeenCalledWith(129);
    expect(exitSpy).not.toHaveBeenCalledWith(0);

    stopSpy.mockRestore();
    captured.restore();
    driver.unregisterSignalHandlers();
  });

  it('SIGTERM handler routes through stop(143) and forces exit 143 on success', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { driver, tui } = makeDriver();
    // `stop()` resolving without exiting models the defensive fallback path
    // where `onExit` was not wired up. The handler must still exit 143 so
    // supervisors see signal termination.
    const stopSpy = vi.spyOn(tui, 'stop').mockResolvedValue(undefined);
    const captured = captureHandlers(driver);

    const sigterm = captured.signalHandlers.get('SIGTERM');
    expect(sigterm).toBeDefined();
    sigterm?.();

    await Promise.resolve();
    await Promise.resolve();

    expect(stopSpy).toHaveBeenCalledWith(143);
    expect(exitSpy).toHaveBeenCalledWith(143);
    expect(exitSpy).not.toHaveBeenCalledWith(0);

    stopSpy.mockRestore();
    captured.restore();
    driver.unregisterSignalHandlers();
  });

  it('emergencyTerminalExit accepts a custom exit code', () => {
    const { driver } = makeDriver();
    (driver as unknown as { emergencyTerminalExit(code?: number): never }).emergencyTerminalExit(
      143,
    );
    expect(exitSpy).toHaveBeenCalledWith(143);
  });

  it('stdout EIO error triggers emergency exit; ENOENT does not', () => {
    const { driver } = makeDriver();
    const captured = captureHandlers(driver);

    const eio = Object.assign(new Error('write EIO'), { code: 'EIO' });
    captured.stdoutErrorHandler?.(eio);
    expect(exitSpy).toHaveBeenCalledWith(129);

    exitSpy.mockClear();
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    captured.stdoutErrorHandler?.(enoent);
    expect(exitSpy).not.toHaveBeenCalled();

    captured.restore();
    driver.unregisterSignalHandlers();
  });

  it('stderr EPIPE error triggers emergency exit', () => {
    const { driver } = makeDriver();
    const captured = captureHandlers(driver);

    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    captured.stderrErrorHandler?.(epipe);
    expect(exitSpy).toHaveBeenCalledWith(129);

    captured.restore();
    driver.unregisterSignalHandlers();
  });

  it('registerSignalHandlers is idempotent (second call replaces first)', () => {
    const { driver } = makeDriver();
    const beforeSigterm = process.listenerCount('SIGTERM');

    driver.registerSignalHandlers();
    driver.registerSignalHandlers();

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm + 1);

    driver.unregisterSignalHandlers();
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });

  it('stop() unregisters previously-installed signal handlers', async () => {
    const { driver, tui } = makeDriver();
    // Suppress real stop work for this test — focus on the cleanup contract.
    vi.spyOn(tui, 'stop').mockImplementation(async () => {
      (tui as unknown as SignalDriver).unregisterSignalHandlers();
    });
    const beforeSigterm = process.listenerCount('SIGTERM');
    driver.registerSignalHandlers();
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm + 1);

    await tui.stop();
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });

  it('stop() drains terminal input before stopping the UI and exiting', async () => {
    const { driver, tui } = makeDriver();
    const events: string[] = [];
    const drainInput = vi.spyOn(driver.state.terminal, 'drainInput').mockImplementation(async () => {
      events.push('drain');
    });
    const uiStop = vi.spyOn(driver.state.ui, 'stop').mockImplementation(() => {
      events.push('ui.stop');
    });
    tui.onExit = vi.fn(async () => {
      events.push('exit');
    });

    await tui.stop();

    expect(drainInput).toHaveBeenCalledOnce();
    expect(uiStop).toHaveBeenCalledOnce();
    expect(tui.onExit).toHaveBeenCalledOnce();
    expect(events).toEqual(['drain', 'ui.stop', 'exit']);
  });

  it('start() unregisters signal handlers when initialization throws', async () => {
    const { tui } = makeDriver();
    // Force the very first awaited call inside start() to reject. We don't
    // care which method blows up — only that the failure surfaces and any
    // listeners we installed up front get cleaned up before the throw escapes.
    vi.spyOn(tui as unknown as { initMainTui(): Promise<boolean> }, 'initMainTui').mockRejectedValue(
      new Error('init boom'),
    );
    // Stub state.ui.stop so the failure-path cleanup does not touch the real
    // event loop.
    vi.spyOn(
      (tui as unknown as { state: { ui: { stop(): void } } }).state.ui,
      'stop',
    ).mockImplementation(() => {});

    const beforeSigterm = process.listenerCount('SIGTERM');
    const beforeSighup = process.listenerCount('SIGHUP');
    const beforeStdout = process.stdout.listenerCount('error');
    const beforeStderr = process.stderr.listenerCount('error');

    await expect(tui.start()).rejects.toThrow(/init boom/);

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
    expect(process.listenerCount('SIGHUP')).toBe(beforeSighup);
    expect(process.stdout.listenerCount('error')).toBe(beforeStdout);
    expect(process.stderr.listenerCount('error')).toBe(beforeStderr);
  });
});
