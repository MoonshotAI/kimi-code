import { describe, it, expect, vi } from 'vitest';

import {
  decideNavigation,
  decideWindowOpen,
  installExternalLinkGuard,
} from '../../src/main/external-links';

describe('decideWindowOpen', () => {
  it('allows blank popups (the debug panel mounts its own UI into one)', () => {
    expect(decideWindowOpen('')).toBe('allow');
    expect(decideWindowOpen('about:blank')).toBe('allow');
  });

  it('sends http(s) links to the system browser', () => {
    expect(decideWindowOpen('https://example.com/pr/1')).toBe('open-external');
    expect(decideWindowOpen('http://127.0.0.1:5174/index.html')).toBe('open-external');
  });

  it('denies everything else (internal schemes, file, javascript)', () => {
    expect(decideWindowOpen('app://renderer/index.html')).toBe('deny');
    expect(decideWindowOpen('file:///etc/passwd')).toBe('deny');
    expect(decideWindowOpen('javascript:alert(1)')).toBe('deny');
  });
});

describe('decideNavigation', () => {
  it('allows same-origin navigation (dev-server reloads, in-app routing)', () => {
    expect(
      decideNavigation('http://127.0.0.1:5174/index.html', 'http://127.0.0.1:5174/other'),
    ).toBe('allow');
  });

  it('sends cross-origin http(s) navigation to the system browser', () => {
    expect(
      decideNavigation('http://127.0.0.1:5174/index.html', 'https://example.com'),
    ).toBe('open-external');
    expect(decideNavigation('app://renderer/index.html', 'https://example.com')).toBe(
      'open-external',
    );
  });

  it('allows non-http(s) targets (internal protocol, blank)', () => {
    expect(decideNavigation('app://renderer/index.html', 'app://renderer/other')).toBe('allow');
    expect(decideNavigation('app://renderer/index.html', 'about:blank')).toBe('allow');
  });
});

describe('installExternalLinkGuard', () => {
  function fakeContents(currentUrl: string) {
    let openHandler: ((details: { url: string }) => { action: string }) | null = null;
    const navListeners: ((event: { preventDefault: () => void }, url: string) => void)[] = [];
    return {
      contents: {
        setWindowOpenHandler: (handler: typeof openHandler) => {
          openHandler = handler;
        },
        on: (channel: string, listener: (event: { preventDefault: () => void }, url: string) => void) => {
          if (channel === 'will-navigate') navListeners.push(listener);
        },
        getURL: () => currentUrl,
      },
      fireWindowOpen: (url: string) => {
        if (openHandler === null) throw new Error('no window-open handler registered');
        return openHandler({ url });
      },
      fireNavigate: (url: string) => {
        const event = { preventDefault: vi.fn() };
        for (const listener of navListeners) listener(event, url);
        return event;
      },
    };
  }

  it('denies the new window and opens http(s) links externally', () => {
    const { contents, fireWindowOpen } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installExternalLinkGuard(contents as any, openExternal);
    expect(fireWindowOpen('https://example.com')).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('allows blank popups without touching the system browser', () => {
    const { contents, fireWindowOpen } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installExternalLinkGuard(contents as any, openExternal);
    expect(fireWindowOpen('about:blank')).toEqual({ action: 'allow' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('prevents cross-origin navigation and opens it externally', () => {
    const { contents, fireNavigate } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installExternalLinkGuard(contents as any, openExternal);
    const event = fireNavigate('https://example.com');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('leaves same-origin navigation alone', () => {
    const { contents, fireNavigate } = fakeContents('http://127.0.0.1:5174/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installExternalLinkGuard(contents as any, openExternal);
    const event = fireNavigate('http://127.0.0.1:5174/hmr-update');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
