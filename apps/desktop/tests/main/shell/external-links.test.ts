import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { error: vi.fn() },
  redactUrlForLog: (url: string) => url,
}));
vi.mock('../../../src/main/app/failure-dialog', () => ({ showFailureFeedback: vi.fn() }));

import {
  decideNavigation,
  decideWindowOpen,
  installExternalLinkGuard,
  isServerApiUrl,
} from '../../../src/main/shell/external-links';

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

  it('denies local file targets so a file link never replaces the app', () => {
    expect(decideNavigation('app://renderer/index.html', 'file:///Users/me/site/index.html')).toBe('deny');
    expect(decideNavigation('http://127.0.0.1:5174/index.html', 'FILE:///C:/site/index.html')).toBe('deny');
  });

  it('allows non-http(s) targets (internal protocol, blank)', () => {
    expect(decideNavigation('app://renderer/index.html', 'app://renderer/other')).toBe('allow');
    expect(decideNavigation('app://renderer/index.html', 'about:blank')).toBe('allow');
  });
});

describe('isServerApiUrl', () => {
  it('matches API paths on the server origin only', () => {
    const origin = 'http://127.0.0.1:58627';
    expect(isServerApiUrl('http://127.0.0.1:58627/api/v1/sessions/s1/fs/a.pdf:download', origin)).toBe(true);
    expect(isServerApiUrl('http://127.0.0.1:58627/api/v1/files/f1', origin)).toBe(true);
    expect(isServerApiUrl('http://127.0.0.1:58627/index.html', origin)).toBe(false);
    expect(isServerApiUrl('http://127.0.0.1:5174/api/v1/files/f1', origin)).toBe(false);
    expect(isServerApiUrl('http://localhost:58627/api/v1/files/f1', origin)).toBe(false);
    expect(isServerApiUrl('not a url', origin)).toBe(false);
  });

  it('honours a server base path', () => {
    const base = 'https://example.test/kimi';
    expect(isServerApiUrl('https://example.test/kimi/api/v1/sessions/s1/fs/a.pdf:download', base)).toBe(true);
    expect(isServerApiUrl('https://example.test/kimi/api/v1/files/f1', `${base}/`)).toBe(true);
    expect(isServerApiUrl('https://example.test/api/v1/files/f1', base)).toBe(false);
    expect(isServerApiUrl('https://example.test/kimi-other/api/v1/files/f1', base)).toBe(false);
    expect(isServerApiUrl('https://example.test/kimi', base)).toBe(false);
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
        session: { downloadURL: vi.fn() },
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
    installExternalLinkGuard(contents as any, openExternal);
    expect(fireWindowOpen('https://example.com')).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('allows blank popups without touching the system browser', () => {
    const { contents, fireWindowOpen } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    installExternalLinkGuard(contents as any, openExternal);
    expect(fireWindowOpen('about:blank')).toEqual({ action: 'allow' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('prevents cross-origin navigation and opens it externally', () => {
    const { contents, fireNavigate } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    installExternalLinkGuard(contents as any, openExternal);
    const event = fireNavigate('https://example.com');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('keeps the window on its page when a Markdown link points at a local file', () => {
    const { contents, fireNavigate } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    installExternalLinkGuard(contents as any, openExternal);
    const event = fireNavigate('file:///Users/me/site/index.html');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('leaves same-origin navigation alone', () => {
    const { contents, fireNavigate } = fakeContents('http://127.0.0.1:5174/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    installExternalLinkGuard(contents as any, openExternal);
    const event = fireNavigate('http://127.0.0.1:5174/hmr-update');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  const serverDownload = 'http://127.0.0.1:58627/api/v1/sessions/s1/fs/report.pdf:download';
  const serverTarget = () => ({ baseUrl: 'http://127.0.0.1:58627', authorization: 'Bearer server-token' });

  it('downloads server API links in-app with the bearer credential instead of opening the system browser', () => {
    const { contents, fireWindowOpen, fireNavigate } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    installExternalLinkGuard(contents as any, openExternal, serverTarget);
    expect(fireWindowOpen(serverDownload)).toEqual({ action: 'deny' });
    const event = fireNavigate(serverDownload);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(contents.session.downloadURL).toHaveBeenCalledTimes(2);
    expect(contents.session.downloadURL).toHaveBeenCalledWith(serverDownload, {
      headers: { Authorization: 'Bearer server-token' },
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('still opens non-API server pages and other sites externally', () => {
    const { contents, fireWindowOpen } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    installExternalLinkGuard(contents as any, openExternal, serverTarget);
    fireWindowOpen('http://127.0.0.1:58627/');
    fireWindowOpen('https://example.com/api/v1/files/f1');
    expect(contents.session.downloadURL).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('downloads in-app from a server behind a path prefix', () => {
    const { contents, fireWindowOpen } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    const prefixed = 'https://example.test/kimi/api/v1/sessions/s1/fs/report.pdf:download';
    installExternalLinkGuard(contents as any, openExternal, () => ({
      baseUrl: 'https://example.test/kimi',
      authorization: 'Bearer server-token',
    }));
    expect(fireWindowOpen(prefixed)).toEqual({ action: 'deny' });
    expect(contents.session.downloadURL).toHaveBeenCalledWith(prefixed, {
      headers: { Authorization: 'Bearer server-token' },
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens server links externally when no server is connected yet', () => {
    const { contents, fireWindowOpen } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    installExternalLinkGuard(contents as any, openExternal, () => null);
    fireWindowOpen(serverDownload);
    expect(contents.session.downloadURL).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(serverDownload);
  });

  it('downloads without an Authorization header when the server has no credential', () => {
    const { contents, fireWindowOpen } = fakeContents('app://renderer/index.html');
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    installExternalLinkGuard(contents as any, openExternal, () => ({ baseUrl: 'http://127.0.0.1:58627' }));
    fireWindowOpen(serverDownload);
    expect(contents.session.downloadURL).toHaveBeenCalledWith(serverDownload, undefined);
  });
});
