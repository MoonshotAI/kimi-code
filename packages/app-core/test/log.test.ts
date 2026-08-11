import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { logError, logInfo, logWarn } from '../src/lib/log';

// Renderer tests run in the node environment, so there is no real `window`;
// each test installs just enough of it to stand in for the preload bridge.
const globalRef = globalThis as { window?: unknown };
const originalWindow = globalRef.window;

let warnSpy: MockInstance<typeof console.warn>;
let errorSpy: MockInstance<typeof console.error>;
let infoSpy: MockInstance<typeof console.info>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWindow === undefined) {
    delete globalRef.window;
  } else {
    globalRef.window = originalWindow;
  }
});

function setBridge(bridge: unknown): void {
  globalRef.window = bridge === undefined ? {} : { kimiDesktop: bridge };
}

describe('lib/log', () => {
  it('mirrors to the console and forwards level/message/detail to the bridge', () => {
    const bridgeLog = vi.fn();
    setBridge({ log: bridgeLog });

    logWarn('[kimi-code] dev backend switch failed:', 'beta');
    expect(warnSpy).toHaveBeenCalledWith('[kimi-code] dev backend switch failed:', 'beta');
    expect(bridgeLog).toHaveBeenCalledWith('warn', '[kimi-code] dev backend switch failed:', 'beta');

    logError('[kimi-code] operation failed: x', new Error('kaput'));
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(bridgeLog).toHaveBeenCalledWith('error', '[kimi-code] operation failed: x', expect.any(Error));

    logInfo('hello');
    expect(infoSpy).toHaveBeenCalledWith('hello');
    expect(bridgeLog).toHaveBeenCalledWith('info', 'hello', undefined);
  });

  it('forwards several extra arguments as one array detail', () => {
    const bridgeLog = vi.fn();
    setBridge({ log: bridgeLog });
    logWarn('[loadFileDiff] diff unavailable for', '/a.ts', new Error('x'));
    expect(bridgeLog).toHaveBeenCalledWith(
      'warn',
      '[loadFileDiff] diff unavailable for',
      ['/a.ts', expect.any(Error)],
    );
  });

  it('is console-only without a bridge (web) or with an old bridge lacking log', () => {
    setBridge(undefined);
    logWarn('no bridge');
    expect(warnSpy).toHaveBeenCalledWith('no bridge');

    setBridge({});
    logWarn('old bridge');
    expect(warnSpy).toHaveBeenCalledWith('old bridge');
  });

  it('swallows bridge failures — logging never breaks the caller', () => {
    setBridge({
      log: () => {
        throw new Error('ipc dead');
      },
    });
    expect(() => logError('boom')).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('boom');
  });
});
