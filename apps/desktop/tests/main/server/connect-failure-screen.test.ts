import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../../../src/main/server/connect';
import type { MainWindow } from '../../../src/main/window/main-window';

const mocks = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('@moonshot-ai/kimi-code-sdk', () => ({ resolveKimiHome: vi.fn(() => '/tmp/kimi') }));
vi.mock('@moonshot-ai/kap-server', () => ({ serverTokenPath: vi.fn(() => '/tmp/kimi/server-token') }));
vi.mock('../../../src/main/server/embedded-server', () => ({ startDesktopServer: vi.fn() }));
vi.mock('../../../src/main/server/server-auth', () => ({
  desktopServerSecret: vi.fn(() => 'secret'),
  setEmbeddedServerOrigin: vi.fn(),
}));
vi.mock('../../../src/main/system/shell-env', () => ({ startShellEnvProbe: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../src/main/server/region', () => ({ setServerRegionSource: vi.fn() }));
vi.mock('../../../src/main/server/remote-control-restore', () => ({
  restoreRemoteControlOnStartup: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../src/main/server/session-continue', () => ({
  continueSessionsAfterRestart: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../src/main/app/protocol', () => ({
  rendererDevBase: vi.fn(() => undefined),
  rendererUrl: vi.fn(() => 'app://renderer/index.html'),
}));
vi.mock('../../../src/main/app/ui-state', () => ({
  isLinuxNativeTitleBar: vi.fn(() => false),
  isOnboarded: vi.fn(() => true),
  isVibrancyEnabled: vi.fn(() => false),
}));
vi.mock('../../../src/main/server/connect-target', () => ({
  resolveConnectTarget: vi.fn(() => ({ external: true, origin: 'http://127.0.0.1:58627', token: 'token' })),
}));
vi.mock('../../../src/main/app/screens', () => ({
  dataUrl: vi.fn((html: string) => `data:text/html,${html}`),
  errorHtml: vi.fn(() => 'error'),
  updateTimeoutHtml: vi.fn(() => 'timeout'),
  waitingHtml: vi.fn(() => 'waiting'),
}));
vi.mock('../../../src/main/diagnostics/log', () => ({
  diagnosticRoots: vi.fn(() => ({ mainLogPath: '/tmp/kimi/desktop.log', serverLogPath: '/tmp/kimi/server.log' })),
  log: { info: vi.fn(), warn: vi.fn(), error: mocks.error },
  logStartup: vi.fn(),
  redactUrlForLog: vi.fn((url: string) => url),
}));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: vi.fn(), trySendDesktopEvent: vi.fn() }));

describe('connect failure screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles a secondary loadURL rejection without an unhandled rejection', async () => {
    const initialFailure = new Error('initial renderer load failed');
    const failureScreenFailure = new Error('error page load failed');
    const loadURL = vi.fn()
      .mockRejectedValueOnce(initialFailure)
      .mockRejectedValueOnce(failureScreenFailure);
    const win = {
      isDestroyed: vi.fn(() => false),
      loadURL,
      webContents: {
        getURL: vi.fn(() => 'app://renderer/index.html'),
        on: vi.fn(),
        removeListener: vi.fn(),
      },
    } as unknown as MainWindow;
    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown): void => {
      unhandled(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      void connect(win);
      await vi.waitFor(() => expect(loadURL).toHaveBeenCalledTimes(2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith('[kimi-desktop] startup failure screen load failed', failureScreenFailure);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
