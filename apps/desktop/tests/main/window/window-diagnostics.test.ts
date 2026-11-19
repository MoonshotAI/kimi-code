import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { info: mocks.info, warn: mocks.warn, error: mocks.error },
  redactUrlForLog: (url: string) => url.split(/[?#]/)[0],
  uptimeMs: () => 1234,
}));

import { attachWindowDiagnostics } from '../../../src/main/window/window-diagnostics';

class FakeContents {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  pid = 4321;
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  getOSProcessId(): number {
    return this.pid;
  }
}

function setup(): { contents: FakeContents; advance: (ms: number) => void } {
  let now = 1_000;
  const contents = new FakeContents();
  attachWindowDiagnostics(contents as never, () => now);
  return { contents, advance: (ms) => (now += ms) };
}

function consoleError(contents: FakeContents, message: string, level = 'error'): void {
  contents.emit('console-message', { level, message, lineNumber: 7, sourceId: 'app://renderer/assets/index.js?v=1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attachWindowDiagnostics', () => {
  it('logs main-frame navigations with redacted URLs and the renderer pid on finish', () => {
    const { contents } = setup();
    contents.emit('did-start-navigation', { url: 'app://renderer/index.html?kimi_origin=x#token=y', isMainFrame: true, isSameDocument: false });
    contents.emit('did-start-navigation', { url: 'app://renderer/sessions/1', isMainFrame: true, isSameDocument: true });
    contents.emit('did-start-navigation', { url: 'https://frame.example.test', isMainFrame: false, isSameDocument: false });
    contents.emit('did-finish-load');
    expect(mocks.info.mock.calls.map(([line]) => line)).toEqual([
      '[nav] start url=app://renderer/index.html at=+1234ms',
      '[nav] finish at=+1234ms renderer_pid=4321',
    ]);
  });

  it('logs main-frame load failures, downgrading aborted loads and ignoring subframes', () => {
    const { contents } = setup();
    contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'app://renderer/index.html#token=y', true);
    contents.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', 'app://renderer/index.html', true);
    contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'app://renderer/frame.html', false);
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      '[nav] fail code=-102 ERR_CONNECTION_REFUSED url=app://renderer/index.html',
    );
    expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
      '[nav] fail-provisional code=-3 ERR_ABORTED url=app://renderer/index.html',
    );
  });

  it('records preload exceptions with their stack', () => {
    const { contents } = setup();
    const error = new Error('validator missing');
    contents.emit('preload-error', {}, '/Applications/Kimi Code.app/Contents/Resources/app.asar/out/preload.cjs', error);
    expect(mocks.error).toHaveBeenCalledWith('[preload] preload.cjs threw', error);
  });

  it('measures how long the renderer stayed unresponsive', () => {
    const { contents, advance } = setup();
    contents.emit('unresponsive');
    advance(4_500);
    contents.emit('responsive');
    expect(mocks.warn).toHaveBeenCalledWith('[proc] renderer unresponsive');
    expect(mocks.info).toHaveBeenCalledWith('[proc] renderer responsive after=4500ms');
  });

  it('reports renderer exits with the last known pid, as errors unless clean', () => {
    const { contents } = setup();
    contents.emit('did-finish-load');
    contents.pid = 0;
    contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 9 });
    contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    expect(mocks.error).toHaveBeenCalledWith('[proc] renderer gone reason=oom exit_code=9 pid=4321');
    expect(mocks.info).toHaveBeenCalledWith('[proc] renderer gone reason=clean-exit exit_code=0 pid=4321');
  });

  it('captures console errors from navigation start until shortly after the load finishes', () => {
    const { contents, advance } = setup();
    contents.emit('did-start-navigation', { url: 'app://renderer/index.html', isMainFrame: true, isSameDocument: false });
    consoleError(contents, 'Uncaught TypeError: x is not a function');
    consoleError(contents, 'just info', 'info');
    contents.emit('did-finish-load');
    advance(14_000);
    consoleError(contents, 'Failed to fetch dynamically imported module');
    advance(2_000);
    consoleError(contents, 'late error');
    expect(mocks.error.mock.calls.map(([line]) => line)).toEqual([
      '[console] Uncaught TypeError: x is not a function (app://renderer/assets/index.js:7)',
      '[console] Failed to fetch dynamically imported module (app://renderer/assets/index.js:7)',
    ]);

    contents.emit('did-start-navigation', { url: 'app://renderer/index.html', isMainFrame: true, isSameDocument: false });
    consoleError(contents, 'after reload');
    expect(mocks.error).toHaveBeenLastCalledWith('[console] after reload (app://renderer/assets/index.js:7)');
  });

  it('caps console capture per document and redacts secrets', () => {
    const { contents } = setup();
    consoleError(contents, 'GET http://127.0.0.1:1/api?token=abc123 401');
    for (let i = 0; i < 40; i += 1) consoleError(contents, `error ${i}`);
    expect(mocks.error).toHaveBeenCalledTimes(30);
    expect(mocks.error.mock.calls[0]?.[0]).toBe(
      '[console] GET http://127.0.0.1:1/api?token=[redacted] 401 (app://renderer/assets/index.js:7)',
    );
  });
});
