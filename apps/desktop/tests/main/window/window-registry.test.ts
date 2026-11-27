import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  getFocusedWindow: vi.fn<() => unknown>(() => null),
  fromWebContents: vi.fn<(contents: unknown) => unknown>(() => null),
  e2eWindowMode: vi.fn<() => string | null>(() => null),
}));

vi.mock('electron', () => {
  class FakeBaseWindow {
    static getFocusedWindow(): unknown {
      return electronMocks.getFocusedWindow();
    }
    isDestroyed(): boolean {
      return false;
    }
  }
  class FakeBrowserWindow {
    static fromWebContents(contents: unknown): unknown {
      return electronMocks.fromWebContents(contents);
    }
    isDestroyed(): boolean {
      return false;
    }
  }
  return {
    app: { on: electronMocks.appOn },
    BaseWindow: FakeBaseWindow,
    BrowserWindow: FakeBrowserWindow,
  };
});

vi.mock('../../../src/main/app/e2e-mode', () => ({
  e2eWindowMode: electronMocks.e2eWindowMode,
}));

function fakeContents(overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
    ...overrides,
  };
}

function fakeMainWindow(contents: unknown, overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: () => false,
    webContents: contents,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  electronMocks.getFocusedWindow.mockReturnValue(null);
  electronMocks.fromWebContents.mockReturnValue(null);
  electronMocks.e2eWindowMode.mockReturnValue(null);
});

describe('window registry', () => {
  it('stores and clears the main window reference', async () => {
    const registry = await import('../../../src/main/window/window-registry');
    expect(registry.getMainWindow()).toBeNull();
    const win = fakeMainWindow(fakeContents());
    registry.setMainWindow(win as never);
    expect(registry.getMainWindow()).toBe(win);
    registry.setMainWindow(null);
    expect(registry.getMainWindow()).toBeNull();
  });

  it('sends to the live main renderer and ignores missing, destroyed, crashed or throwing targets', async () => {
    const registry = await import('../../../src/main/window/window-registry');
    expect(() => registry.sendToRenderer('kimi:menu-action' as never, 'undo')).not.toThrow();

    const live = fakeContents();
    registry.setMainWindow(fakeMainWindow(live) as never);
    registry.sendToRenderer('kimi:menu-action' as never, 'undo', 1);
    expect(live.send).toHaveBeenCalledWith('kimi:menu-action', 'undo', 1);

    for (const broken of [
      fakeMainWindow(fakeContents(), { isDestroyed: () => true }),
      fakeMainWindow(fakeContents({ isDestroyed: () => true })),
      fakeMainWindow(fakeContents({ isCrashed: () => true })),
      fakeMainWindow(fakeContents({ send: vi.fn(() => { throw new Error('gone'); }) })),
    ]) {
      registry.setMainWindow(broken as never);
      expect(() => registry.sendToRenderer('kimi:menu-action' as never)).not.toThrow();
    }
  });

  it('resolves windows for web contents and focused window contents', async () => {
    const registry = await import('../../../src/main/window/window-registry');
    const { BrowserWindow, BaseWindow } = await import('electron');
    const contents = fakeContents();
    const win = fakeMainWindow(contents);
    const fallback = {};
    electronMocks.fromWebContents.mockReturnValue(fallback);

    registry.setMainWindow(win as never);
    expect(registry.windowForWebContents(contents as never)).toBe(win);
    const other = fakeContents();
    expect(registry.windowForWebContents(other as never)).toBe(fallback);
    expect(electronMocks.fromWebContents).toHaveBeenCalledWith(other);

    expect(registry.focusedWindowWebContents()).toBeUndefined();
    electronMocks.getFocusedWindow.mockReturnValue(win);
    expect(registry.focusedWindowWebContents()).toBe(contents);

    const popupContents = fakeContents();
    const popup = new (BrowserWindow as unknown as new () => object)();
    Object.assign(popup, { isDestroyed: () => false, webContents: popupContents });
    electronMocks.getFocusedWindow.mockReturnValue(popup);
    expect(registry.focusedWindowWebContents()).toBe(popupContents);

    electronMocks.getFocusedWindow.mockReturnValue(new (BaseWindow as unknown as new () => object)());
    expect(registry.focusedWindowWebContents()).toBeUndefined();
  });

  it('tracks quitting state, installs before-quit once, and preserves the skip marker after cancel', async () => {
    const registry = await import('../../../src/main/window/window-registry');
    expect(registry.isMarkedQuitting()).toBe(false);
    expect(registry.isQuitConfirmSkipped()).toBe(false);

    electronMocks.e2eWindowMode.mockReturnValue('quiet');
    expect(registry.isQuitConfirmSkipped()).toBe(true);
    electronMocks.e2eWindowMode.mockReturnValue(null);

    registry.installQuitWatch();
    registry.installQuitWatch();
    expect(electronMocks.appOn).toHaveBeenCalledTimes(1);
    const [, beforeQuit] = electronMocks.appOn.mock.calls[0] as [string, () => void];
    beforeQuit();
    expect(registry.isMarkedQuitting()).toBe(true);
    expect(registry.isQuitConfirmSkipped()).toBe(false);

    registry.cancelQuitting();
    expect(registry.isMarkedQuitting()).toBe(false);

    registry.markQuitting();
    expect(registry.isMarkedQuitting()).toBe(true);
    expect(registry.isQuitConfirmSkipped()).toBe(true);
    registry.cancelQuitting();
    expect(registry.isMarkedQuitting()).toBe(false);
    expect(registry.isQuitConfirmSkipped()).toBe(true);
  });

  it('notifies gone listeners and short-circuits close interceptors on the first veto', async () => {
    const registry = await import('../../../src/main/window/window-registry');
    let gone = 0;
    registry.onMainWindowGone(() => { gone += 1; });
    registry.notifyMainWindowGone();
    expect(gone).toBe(1);

    expect(registry.shouldInterceptMainWindowClose()).toBe(false);
    const first = vi.fn(() => false);
    const veto = vi.fn(() => true);
    const neverCalled = vi.fn(() => true);
    registry.addMainWindowCloseInterceptor(first);
    registry.addMainWindowCloseInterceptor(veto);
    registry.addMainWindowCloseInterceptor(neverCalled);
    expect(registry.shouldInterceptMainWindowClose()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(veto).toHaveBeenCalledTimes(1);
    expect(neverCalled).not.toHaveBeenCalled();
  });
});
