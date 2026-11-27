import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => {
  const goneListeners: Array<() => void> = [];
  const closeInterceptors: Array<() => boolean> = [];
  return {
    embeddedServerOrigin: vi.fn((): string | null => 'http://127.0.0.1:54321'),
    desktopServerSecret: vi.fn((): string => 'launch-secret'),
    showMessageBox: vi.fn(),
    trackDesktopEvent: vi.fn(),
    logWarn: vi.fn(),
    getLocale: vi.fn(() => 'zh-CN'),
    isRendererReady: vi.fn(() => false),
    isQuitConfirmSkipped: vi.fn(() => false),
    sendToRenderer: vi.fn(),
    showMainWindow: vi.fn(),
    setRemoteControlPreviousEnabled: vi.fn(),
    mainWindowGoneListeners: goneListeners,
    onMainWindowGone: vi.fn((listener: () => void) => {
      goneListeners.push(listener);
    }),
    mainWindowCloseInterceptors: closeInterceptors,
    addMainWindowCloseInterceptor: vi.fn((interceptor: () => boolean) => {
      closeInterceptors.push(interceptor);
    }),
  };
});

vi.mock('electron', () => ({
  app: {
    getLocale: mocks.getLocale,
  },
  dialog: {
    showMessageBox: mocks.showMessageBox,
  },
}));

vi.mock('../../../src/main/server/connect', () => ({
  embeddedServerOrigin: mocks.embeddedServerOrigin,
}));

vi.mock('../../../src/main/server/server-auth', () => ({
  desktopServerSecret: mocks.desktopServerSecret,
}));

vi.mock('../../../src/main/diagnostics/track', () => ({
  trackDesktopEvent: mocks.trackDesktopEvent,
  trySendDesktopEvent: vi.fn(),
}));

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { warn: mocks.logWarn, info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/app/ui-state', () => ({
  setRemoteControlPreviousEnabled: mocks.setRemoteControlPreviousEnabled,
}));

vi.mock('../../../src/main/window/window-registry', () => ({
  isQuitConfirmSkipped: mocks.isQuitConfirmSkipped,
  sendToRenderer: mocks.sendToRenderer,
  onMainWindowGone: mocks.onMainWindowGone,
  addMainWindowCloseInterceptor: mocks.addMainWindowCloseInterceptor,
}));
vi.mock('../../../src/main/window/main-window', () => ({
  isRendererReady: mocks.isRendererReady,
  showMainWindow: mocks.showMainWindow,
}));

import {
  busySessionsUrl,
  confirmUpdateRestart,
  hasBusySession,
  quitConfirmStrings,
  remoteControlEnabled,
  remoteControlStatusUrl,
  resolveQuitConfirmResponse,
  setQuitConfirmLocale,
  shouldBlockQuit,
} from '../../../src/main/app/quit-confirm';
import { IPC } from '../../../src/main/ipc/ipc-channels';

const QUIT_DETAILS = { purpose: 'quit', sessionTitles: [] };

function fakeWindow(visible: boolean): BrowserWindow {
  return {
    isDestroyed: () => false,
    isVisible: () => visible,
  } as unknown as BrowserWindow;
}

function envelope(items: unknown[]): unknown {
  return { code: 0, msg: '', data: { items, has_more: false }, request_id: 'r' };
}

function rcEnvelope(enabled: boolean): unknown {
  return { code: 0, msg: '', data: { enabled, state: enabled ? 'on' : 'off' }, request_id: 'r' };
}

function jsonResponse(payload: unknown): unknown {
  return { ok: true, json: () => Promise.resolve(payload) };
}

function stubQuitFetch(busyItems: unknown[], rcEnabled = false): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.includes('/api/v1/remote-control')
        ? Promise.resolve(jsonResponse(rcEnvelope(rcEnabled)))
        : Promise.resolve(jsonResponse(envelope(busyItems))),
    ),
  );
}

function stubDeferredSessionsFetch(): { resolvers: Array<(payload: unknown) => void> } {
  const resolvers: Array<(payload: unknown) => void> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/api/v1/remote-control')) {
        return Promise.resolve(jsonResponse(rcEnvelope(false)));
      }
      return new Promise((resolve) => {
        resolvers.push((payload: unknown) => resolve(jsonResponse(payload)));
      });
    }),
  );
  return { resolvers };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.embeddedServerOrigin.mockReturnValue('http://127.0.0.1:54321');
  mocks.desktopServerSecret.mockReturnValue('launch-secret');
  mocks.getLocale.mockReturnValue('zh-CN');
  mocks.isRendererReady.mockReturnValue(false);
  mocks.isQuitConfirmSkipped.mockReturnValue(false);
  setQuitConfirmLocale('en');
});

describe('hasBusySession', () => {
  it('returns true when the page has at least one session', () => {
    expect(hasBusySession(envelope([{ id: 's1', busy: true }]))).toBe(true);
  });

  it('returns false for an empty page', () => {
    expect(hasBusySession(envelope([]))).toBe(false);
  });

  it('returns false for malformed payloads', () => {
    expect(hasBusySession(null)).toBe(false);
    expect(hasBusySession(undefined)).toBe(false);
    expect(hasBusySession('busy')).toBe(false);
    expect(hasBusySession({ data: null })).toBe(false);
    expect(hasBusySession({ data: { items: 'nope' } })).toBe(false);
  });
});

describe('remoteControlEnabled', () => {
  it('returns true only when the status payload says enabled', () => {
    expect(remoteControlEnabled(rcEnvelope(true))).toBe(true);
    expect(remoteControlEnabled(rcEnvelope(false))).toBe(false);
    expect(remoteControlEnabled(null)).toBe(false);
    expect(remoteControlEnabled({ data: null })).toBe(false);
    expect(remoteControlEnabled({ data: { enabled: 'yes' } })).toBe(false);
  });

  it('returns true while this process is still starting the tunnel', () => {
    expect(remoteControlEnabled({ code: 0, data: { enabled: false, state: 'starting' } })).toBe(true);
    expect(remoteControlEnabled({ code: 0, data: { enabled: false, state: 'stopping' } })).toBe(false);
    expect(remoteControlEnabled({ code: 0, data: { enabled: false, state: 'off' } })).toBe(false);
  });
});

describe('busySessionsUrl', () => {
  it('queries the first page of busy sessions', () => {
    expect(busySessionsUrl('http://127.0.0.1:1')).toBe(
      'http://127.0.0.1:1/api/v1/sessions?busy=true&page_size=1&archived=all',
    );
  });

  it('queries the remote control status endpoint', () => {
    expect(remoteControlStatusUrl('http://127.0.0.1:1')).toBe(
      'http://127.0.0.1:1/api/v1/remote-control',
    );
  });
});

describe('quitConfirmStrings', () => {
  it('provides zh and en copy with cancel and quit buttons', () => {
    expect(quitConfirmStrings('zh')).toMatchObject({ cancel: '取消', quit: '退出' });
    expect(quitConfirmStrings('zh').title).toContain('Kimi Code');
    expect(quitConfirmStrings('en')).toMatchObject({ cancel: 'Cancel', quit: 'Quit' });
    expect(quitConfirmStrings('en').title).toContain('Kimi Code');
    expect(quitConfirmStrings('zh').detailRemoteControl).not.toContain('重启后需手动开启');
    expect(quitConfirmStrings('en').detailRemoteControl).not.toContain('turn it on again');
  });
});

describe('shouldBlockQuit', () => {
  it('does not block when no embedded server is running', async () => {
    mocks.embeddedServerOrigin.mockReturnValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('does not block when the busy query fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(false);
    expect(mocks.logWarn).toHaveBeenCalledTimes(2);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('does not block when the server responds with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(false);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('does not block when no session is busy', async () => {
    stubQuitFetch([]);
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(false);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('sends the per-launch secret and busy filter on the query', async () => {
    const fetchMock = vi.fn((url: string) =>
      url.includes('/api/v1/remote-control')
        ? Promise.resolve(jsonResponse(rcEnvelope(false)))
        : Promise.resolve(jsonResponse(envelope([]))),
    );
    vi.stubGlobal('fetch', fetchMock);
    await shouldBlockQuit(fakeWindow(true));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:54321/api/v1/sessions?busy=true&page_size=1&archived=all');
    expect(init.headers['Authorization']).toBe('Bearer launch-secret');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://127.0.0.1:54321/api/v1/remote-control');
  });

  it('persists the actual Remote Control state during the quit check', async () => {
    stubQuitFetch([], false);
    await shouldBlockQuit(fakeWindow(true));
    expect(mocks.setRemoteControlPreviousEnabled).toHaveBeenLastCalledWith(false);

    stubQuitFetch([], true);
    await shouldBlockQuit(fakeWindow(true));
    expect(mocks.setRemoteControlPreviousEnabled).toHaveBeenLastCalledWith(true);
  });

  it('preserves the saved state when the Remote Control response is invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('/api/v1/remote-control')
          ? Promise.resolve(jsonResponse({ code: 500, msg: 'unavailable', data: null }))
          : Promise.resolve(jsonResponse(envelope([]))),
      ),
    );

    await shouldBlockQuit(fakeWindow(true));

    expect(mocks.setRemoteControlPreviousEnabled).not.toHaveBeenCalled();
  });

  it('blocks the quit when a busy session exists and the user cancels', async () => {
    stubQuitFetch([{ id: 's1', busy: true }]);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(true);
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'shown' });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'cancel' });
  });

  it('lets the quit through when a busy session exists and the user confirms', async () => {
    stubQuitFetch([{ id: 's1', busy: true }]);
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(false);
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'quit' });
  });

  it('asks a plain quit from the busy probe alone and offers no continue option', async () => {
    stubQuitFetch([{ id: 's1', title: 'Fix login bug', activity: 'turn' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });

    expect(await shouldBlockQuit(fakeWindow(true))).toBe(false);

    const options = mocks.showMessageBox.mock.calls[0]![1] as Record<string, unknown>;
    expect(options['detail']).toBe('Sessions are still in progress on this machine and will be interrupted if you quit.');
    expect(options['checkboxLabel']).toBeUndefined();
    expect(options['checkboxChecked']).toBe(false);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:54321/api/v1/sessions?busy=true&page_size=1&archived=all',
      'http://127.0.0.1:54321/api/v1/remote-control',
    ]);
  });

  it('still resolves when telemetry tracking throws', async () => {
    stubQuitFetch([{ id: 's1', busy: true }]);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    mocks.trackDesktopEvent.mockImplementation(() => {
      throw new Error('telemetry down');
    });
    await expect(shouldBlockQuit(fakeWindow(true))).resolves.toBe(true);
  });

  it('anchors the dialog to the main window while it is visible', async () => {
    stubQuitFetch([{ id: 's1' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    const win = fakeWindow(true);
    await shouldBlockQuit(win);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ type: 'warning', defaultId: 0, cancelId: 0 }),
    );
  });

  it('shows a windowless dialog when the main window is hidden', async () => {
    stubQuitFetch([{ id: 's1' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    await shouldBlockQuit(fakeWindow(false));
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
    );
  });

  it('prefers the app locale pushed from the renderer', async () => {
    setQuitConfirmLocale('en');
    stubQuitFetch([{ id: 's1' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    await shouldBlockQuit(null);
    const options = mocks.showMessageBox.mock.calls[0]![0] as { buttons: string[] };
    expect(options.buttons).toEqual(['Cancel', 'Quit']);
  });

  it('uses the zh copy for a zh system locale by default', async () => {
    setQuitConfirmLocale(null);
    stubQuitFetch([{ id: 's1' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    await shouldBlockQuit(null);
    const options = mocks.showMessageBox.mock.calls[0]![0] as { buttons: string[] };
    expect(options.buttons).toEqual(['取消', '退出']);
  });

  it('blocks the quit when remote control is on even without busy sessions', async () => {
    stubQuitFetch([], true);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(true);
    const options = mocks.showMessageBox.mock.calls[0]![1] as { detail: string };
    expect(options.detail).toContain('Remote Control is running');
  });

  it('mentions both reasons when sessions are busy and remote control is on', async () => {
    stubQuitFetch([{ id: 's1', busy: true }], true);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(true);
    const options = mocks.showMessageBox.mock.calls[0]![1] as { detail: string };
    expect(options.detail).toContain('Sessions are still in progress');
    expect(options.detail).toContain('Remote Control');
  });

  it('does not block when remote control is held by another process', async () => {
    stubQuitFetch([], false);
    expect(await shouldBlockQuit(fakeWindow(true))).toBe(false);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  describe('in-app confirmation dialog', () => {
    function busyFetch(): void {
      stubQuitFetch([{ id: 's1', busy: true }]);
    }

    it('asks the renderer instead of the native dialog and quits on confirm', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() =>
        expect(mocks.sendToRenderer).toHaveBeenCalledWith(
          IPC.quitConfirm,
          expect.any(Number),
          ['busy'],
          QUIT_DETAILS,
        ),
      );
      expect(mocks.showMainWindow).toHaveBeenCalledOnce();
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'shown' });
      resolveQuitConfirmResponse('quit');
      expect(await pending).toBe(false);
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'quit' });
    });

    it('passes the remote control reason to the in-app prompt', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      stubQuitFetch([{ id: 's1', busy: true }], true);
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() =>
        expect(mocks.sendToRenderer).toHaveBeenCalledWith(
          IPC.quitConfirm,
          expect.any(Number),
          ['busy', 'remote-control'],
          QUIT_DETAILS,
        ),
      );
      resolveQuitConfirmResponse('cancel');
      expect(await pending).toBe(true);
    });

    it('blocks the quit when the renderer answers cancel', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      resolveQuitConfirmResponse('cancel');
      expect(await pending).toBe(true);
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'cancel' });
    });

    it('falls back to the native dialog when the renderer is not ready', async () => {
      mocks.isRendererReady.mockReturnValue(false);
      busyFetch();
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      expect(await shouldBlockQuit(fakeWindow(true))).toBe(false);
      expect(mocks.sendToRenderer).not.toHaveBeenCalled();
      expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    });

    it('falls back to the native dialog when the window is destroyed', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const win = { isDestroyed: () => true, isVisible: () => true } as unknown as BrowserWindow;
      expect(await shouldBlockQuit(win)).toBe(true);
      expect(mocks.sendToRenderer).not.toHaveBeenCalled();
    });

    it('falls back to the native dialog when there is no window', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      expect(await shouldBlockQuit(null)).toBe(true);
      expect(mocks.sendToRenderer).not.toHaveBeenCalled();
    });

    it('ignores a response when no prompt is pending', () => {
      expect(() => resolveQuitConfirmResponse('quit')).not.toThrow();
    });

    it('settles the pending prompt as cancel when the window goes away', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      for (const listener of mocks.mainWindowGoneListeners) listener();
      expect(await pending).toBe(true);
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'cancel' });
    });

    it('tells the still-alive renderer to dismiss the prompt when the window goes away', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      const requestId = mocks.sendToRenderer.mock.calls[0]![1] as number;
      for (const listener of mocks.mainWindowGoneListeners) listener();
      expect(await pending).toBe(true);
      expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC.quitConfirmCancel, requestId);
    });

    it('does not notify the renderer when the window goes away without a pending prompt', () => {
      for (const listener of mocks.mainWindowGoneListeners) listener();
      expect(mocks.sendToRenderer).not.toHaveBeenCalled();
    });

    it('swallows a titlebar close while pending and settles it as cancel', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      const requestId = mocks.sendToRenderer.mock.calls[0]![1] as number;
      expect(mocks.mainWindowCloseInterceptors).toHaveLength(1);
      const interceptor = mocks.mainWindowCloseInterceptors[0]!;
      expect(interceptor()).toBe(true);
      expect(await pending).toBe(true);
      expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC.quitConfirmCancel, requestId);
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'cancel' });
      expect(interceptor()).toBe(false);
    });

    it('lets the close through when no in-app prompt is pending', () => {
      expect(mocks.mainWindowCloseInterceptors).toHaveLength(1);
      expect(mocks.mainWindowCloseInterceptors[0]!()).toBe(false);
    });

    it('swallows a titlebar close that lands during the busy-session query', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      const { resolvers } = stubDeferredSessionsFetch();
      const pending = shouldBlockQuit(fakeWindow(true));
      const interceptor = mocks.mainWindowCloseInterceptors[0]!;
      expect(interceptor()).toBe(true);
      expect(mocks.sendToRenderer).not.toHaveBeenCalled();
      resolvers[0]!(envelope([{ id: 's1', busy: true }]));
      await vi.waitFor(() =>
        expect(mocks.sendToRenderer).toHaveBeenCalledWith(
          IPC.quitConfirm,
          expect.any(Number),
          ['busy'],
          QUIT_DETAILS,
        ),
      );
      resolveQuitConfirmResponse('cancel');
      expect(await pending).toBe(true);
      expect(interceptor()).toBe(false);
    });

    it('lets the close through once the quit is explicitly confirmed', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      mocks.isQuitConfirmSkipped.mockReturnValue(true);
      const interceptor = mocks.mainWindowCloseInterceptors[0]!;
      expect(interceptor()).toBe(false);
      expect(await pending).toBe(true);
      expect(interceptor()).toBe(false);
    });

    it('lets a titlebar close through during a check that must not intercept window closes', async () => {
      const { resolvers } = stubDeferredSessionsFetch();
      const pending = shouldBlockQuit(fakeWindow(true), { interceptWindowClose: false });
      const interceptor = mocks.mainWindowCloseInterceptors[0]!;
      expect(interceptor()).toBe(false);
      resolvers[0]!(envelope([]));
      expect(await pending).toBe(false);
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(interceptor()).toBe(false);
    });

    it('stops swallowing closes once the quit-initiated check settles while an exempt check is still running', async () => {
      const { resolvers } = stubDeferredSessionsFetch();
      const quitCheck = shouldBlockQuit(fakeWindow(true));
      const exemptCheck = shouldBlockQuit(fakeWindow(true), { interceptWindowClose: false });
      const interceptor = mocks.mainWindowCloseInterceptors[0]!;
      expect(interceptor()).toBe(true);
      resolvers[0]!(envelope([]));
      expect(await quitCheck).toBe(false);
      expect(interceptor()).toBe(false);
      resolvers[1]!(envelope([]));
      expect(await exemptCheck).toBe(false);
    });

    it('lets a confirmed quit through while another busy-session check is still running', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      const { resolvers } = stubDeferredSessionsFetch();
      const importCheck = shouldBlockQuit(fakeWindow(true));
      const quitCheck = shouldBlockQuit(fakeWindow(true));
      resolvers[1]!(envelope([{ id: 's1', busy: true }]));
      await vi.waitFor(() =>
        expect(mocks.sendToRenderer).toHaveBeenCalledWith(
          IPC.quitConfirm,
          expect.any(Number),
          ['busy'],
          QUIT_DETAILS,
        ),
      );
      resolveQuitConfirmResponse('quit');
      expect(await quitCheck).toBe(false);
      mocks.isQuitConfirmSkipped.mockReturnValue(true);
      const interceptor = mocks.mainWindowCloseInterceptors[0]!;
      expect(interceptor()).toBe(false);
      resolvers[0]!(envelope([{ id: 's1', busy: true }]));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledTimes(2));
      resolveQuitConfirmResponse('cancel');
      expect(await importCheck).toBe(true);
    });

    it('serializes overlapping prompts so responses cannot cross requests', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      const first = shouldBlockQuit(fakeWindow(true));
      const second = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      resolveQuitConfirmResponse('quit');
      expect(await first).toBe(false);
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledTimes(2));
      resolveQuitConfirmResponse('cancel');
      expect(await second).toBe(true);
    });

    it('waits for a delayed renderer response without falling back to native', async () => {
      vi.useFakeTimers();
      try {
        mocks.isRendererReady.mockReturnValue(true);
        busyFetch();
        const pending = shouldBlockQuit(fakeWindow(true));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.sendToRenderer).toHaveBeenCalledOnce();
        expect(mocks.showMessageBox).not.toHaveBeenCalled();

        const requestId = mocks.sendToRenderer.mock.calls[0]![1] as number;
        resolveQuitConfirmResponse('quit', requestId);
        await expect(pending).resolves.toBe(false);
        expect(mocks.showMessageBox).not.toHaveBeenCalled();
        expect(mocks.sendToRenderer).not.toHaveBeenCalledWith(IPC.quitConfirmCancel, expect.any(Number));
        expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'quit' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls back to the native dialog when the renderer reports unavailable', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      mocks.showMessageBox.mockResolvedValue({ response: 1 });
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      const requestId = mocks.sendToRenderer.mock.calls[0]![1] as number;
      resolveQuitConfirmResponse('unavailable', requestId);
      expect(await pending).toBe(false);
      expect(mocks.showMessageBox).toHaveBeenCalledOnce();
      expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC.quitConfirmCancel, requestId);
    });

    it('ignores a response carrying a stale request id', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      busyFetch();
      const pending = shouldBlockQuit(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      const requestId = mocks.sendToRenderer.mock.calls[0]![1] as number;
      resolveQuitConfirmResponse('quit', requestId + 999);
      resolveQuitConfirmResponse('cancel', requestId);
      expect(await pending).toBe(true);
    });
  });
});

describe('confirmUpdateRestart', () => {
  const running = (id: string, title: string): unknown => ({ id, title, activity: 'turn' });

  it('restarts without a prompt when nothing is running', async () => {
    stubQuitFetch([]);
    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: true, continueSessionIds: [] });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('restarts without a prompt when no embedded server is running', async () => {
    mocks.embeddedServerOrigin.mockReturnValue(null);
    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: true, continueSessionIds: [] });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('lists the running sessions and offers to continue them, checked by default', async () => {
    stubQuitFetch([running('s1', 'Fix login bug'), { id: 's2', title: '', last_prompt: 'Write\n  tests', activity: 'turn' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });

    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: true, continueSessionIds: ['s1', 's2'] });

    const options = mocks.showMessageBox.mock.calls[0]![1] as Record<string, unknown>;
    expect(options).toMatchObject({
      message: 'Restart and update Kimi Code?',
      detail: 'These sessions are still in progress and will be interrupted by the restart:\n• Fix login bug\n• Write tests',
      buttons: ['Cancel', 'Restart & Update'],
      checkboxLabel: 'Continue these sessions after restart',
      checkboxChecked: true,
      defaultId: 0,
      cancelId: 0,
    });
  });

  it('restarts without continuing when the user clears the option', async () => {
    stubQuitFetch([running('s1', 'Fix login bug')]);
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: true, continueSessionIds: [] });
  });

  it('keeps the app running when the user cancels', async () => {
    stubQuitFetch([running('s1', 'Fix login bug')]);
    mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true });
    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: false, continueSessionIds: [] });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('quit_confirmation', { action: 'cancel' });
  });

  it('shows the first three titles and counts the rest', async () => {
    stubQuitFetch(['a', 'b', 'c', 'd', 'e'].map((id) => running(id, `Task ${id}`)));
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    await confirmUpdateRestart(null);
    const { detail } = mocks.showMessageBox.mock.calls[0]![0] as { detail: string };
    expect(detail.split('\n').slice(1)).toEqual(['• Task a', '• Task b', '• Task c', 'and 2 more']);
  });

  it('uses the zh copy for the update prompt', async () => {
    setQuitConfirmLocale('zh');
    stubQuitFetch(['a', 'b', 'c', 'd'].map((id) => running(id, `任务 ${id}`)));
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    await confirmUpdateRestart(null);
    const options = mocks.showMessageBox.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({
      message: '重启并更新 Kimi Code？',
      buttons: ['取消', '重启并更新'],
      checkboxLabel: '重启后继续这些会话',
    });
    expect(options['detail']).toContain('以及其他 1 个会话');
  });

  it('offers no checkbox when only background work is running', async () => {
    stubQuitFetch([{ id: 's1', title: 'Indexing', activity: 'background' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });

    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: true, continueSessionIds: [] });

    const options = mocks.showMessageBox.mock.calls[0]![1] as Record<string, unknown>;
    expect(options['detail']).toBe('Sessions are still in progress on this machine and will be interrupted by the restart.');
    expect(options['checkboxLabel']).toBeUndefined();
    expect(options['checkboxChecked']).toBe(false);
  });

  it('lists and continues only the running turns when other sessions run background work', async () => {
    stubQuitFetch([running('s1', 'Fix login bug'), { id: 's2', title: 'Indexing', activity: 'background' }]);
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });

    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: true, continueSessionIds: ['s1'] });

    const { detail } = mocks.showMessageBox.mock.calls[0]![1] as { detail: string };
    expect(detail).toBe('These sessions are still in progress and will be interrupted by the restart:\n• Fix login bug');
  });

  it('warns about Remote Control in the restart wording', async () => {
    stubQuitFetch([running('s1', 'Fix login bug')], true);
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    await confirmUpdateRestart(fakeWindow(true));
    const { detail } = mocks.showMessageBox.mock.calls[0]![1] as { detail: string };
    expect(detail.endsWith('\n\nRemote Control is running and will be interrupted by the restart')).toBe(true);
    expect(mocks.setRemoteControlPreviousEnabled).toHaveBeenLastCalledWith(true);
  });

  it('keeps the generic warning without the option when the session list fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/api/v1/remote-control')) return Promise.resolve(jsonResponse(rcEnvelope(false)));
        if (url.includes('page_size=100')) return Promise.resolve({ ok: false, status: 500 });
        return Promise.resolve(jsonResponse(envelope([running('s1', 'Fix login bug')])));
      }),
    );
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });

    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: true, continueSessionIds: [] });

    const options = mocks.showMessageBox.mock.calls[0]![1] as Record<string, unknown>;
    expect(options['detail']).toBe('Sessions are still in progress on this machine and will be interrupted by the restart.');
    expect(options['checkboxLabel']).toBeUndefined();
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
  });

  it('restarts without a prompt when every busy query fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('/api/v1/remote-control')
          ? Promise.resolve(jsonResponse(rcEnvelope(false)))
          : Promise.resolve({ ok: false, status: 500 }),
      ),
    );
    expect(await confirmUpdateRestart(fakeWindow(true))).toEqual({ proceed: true, continueSessionIds: [] });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  describe('in-app confirmation dialog', () => {
    it('sends the running session titles and continues exactly the sessions it showed', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      stubQuitFetch([running('s1', 'Fix login bug'), { id: 's2', title: 'Indexing', activity: 'background' }]);
      const pending = confirmUpdateRestart(fakeWindow(true));
      await vi.waitFor(() =>
        expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC.quitConfirm, expect.any(Number), ['busy'], {
          purpose: 'update',
          sessionTitles: ['Fix login bug'],
        }),
      );
      const requestId = mocks.sendToRenderer.mock.calls[0]![1] as number;
      resolveQuitConfirmResponse('quit', requestId, true);
      expect(await pending).toEqual({ proceed: true, continueSessionIds: ['s1'] });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('ignores a continue answer when no session was offered', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      stubQuitFetch([{ id: 's1', title: 'Indexing', activity: 'background' }]);
      const pending = confirmUpdateRestart(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      const requestId = mocks.sendToRenderer.mock.calls[0]![1] as number;
      resolveQuitConfirmResponse('quit', requestId, true);
      expect(await pending).toEqual({ proceed: true, continueSessionIds: [] });
    });

    it('carries the checkbox answer through the native fallback', async () => {
      mocks.isRendererReady.mockReturnValue(true);
      stubQuitFetch([running('s1', 'Fix login bug')]);
      mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });
      const pending = confirmUpdateRestart(fakeWindow(true));
      await vi.waitFor(() => expect(mocks.sendToRenderer).toHaveBeenCalledOnce());
      const requestId = mocks.sendToRenderer.mock.calls[0]![1] as number;
      resolveQuitConfirmResponse('unavailable', requestId);
      expect(await pending).toEqual({ proceed: true, continueSessionIds: ['s1'] });
      expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    });
  });
});
