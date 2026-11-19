import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.1.0'),
    setAsDefaultProtocolClient: vi.fn(),
  },
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('../../../src/main/diagnostics/log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/diagnostics/log')>();
  return { ...actual, log: mocks.log };
});

import {
  DEEP_LINK_SCHEME,
  extractDeepLink,
  handleDeepLink,
  isKnownDeepLink,
  registerDeepLinkScheme,
} from '../../../src/main/app/deep-link';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.app.isPackaged = true;
  mocks.app.getVersion.mockReturnValue('1.1.0');
});

describe('isKnownDeepLink', () => {
  it('accepts the auth-success URL', () => {
    expect(isKnownDeepLink('kimi-code://auth/success')).toBe(true);
  });

  it('accepts scheme/host case variants but keeps the path case-sensitive', () => {
    expect(isKnownDeepLink('KIMI-CODE://auth/success')).toBe(true);
    expect(isKnownDeepLink('kimi-code://AUTH/success')).toBe(true);
    expect(isKnownDeepLink('kimi-code://auth/Success')).toBe(false);
  });

  it('rejects unknown paths, schemes, and junk', () => {
    expect(isKnownDeepLink('kimi-code://auth/success/extra')).toBe(false);
    expect(isKnownDeepLink('kimi-code://auth/failure')).toBe(false);
    expect(isKnownDeepLink('kimi-code://open')).toBe(false);
    expect(isKnownDeepLink('https://auth/success')).toBe(false);
    expect(isKnownDeepLink('kimi-code:auth/success')).toBe(false);
    expect(isKnownDeepLink('')).toBe(false);
  });

  it('rejects query and fragment', () => {
    expect(isKnownDeepLink('kimi-code://auth/success?code=x')).toBe(false);
    expect(isKnownDeepLink('kimi-code://auth/success#token=x')).toBe(false);
  });
});

describe('extractDeepLink', () => {
  it('finds a deep link among process arguments', () => {
    expect(extractDeepLink(['Kimi Code.exe', '--new-chat', 'kimi-code://auth/success'])).toBe(
      'kimi-code://auth/success',
    );
  });

  it('finds a deep link with an uppercased scheme (same protocol)', () => {
    expect(extractDeepLink(['Kimi Code.exe', 'KIMI-CODE://unknown/path'])).toBe(
      'KIMI-CODE://unknown/path',
    );
  });

  it('returns undefined for a plain relaunch argv', () => {
    expect(extractDeepLink(['Kimi Code.exe'])).toBeUndefined();
    expect(extractDeepLink(['electron', '.', '--workspace=/work/kimi'])).toBeUndefined();
  });
});

describe('registerDeepLinkScheme', () => {
  const realPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
    vi.unstubAllEnvs();
  });

  function asWindows(): void {
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
  }

  function asMac(): void {
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
  }

  it('no-ops in packaged builds on macOS/Linux (Info.plist / desktop file register it)', () => {
    asMac();
    mocks.app.isPackaged = true;
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('registers the scheme for unpackaged dev launches on Windows/Linux', () => {
    asWindows();
    mocks.app.isPackaged = false;
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      DEEP_LINK_SCHEME,
      process.execPath,
      [process.argv[1] ?? '.'],
    );
  });

  it('no-ops on macOS dev — registration would claim the bare Electron.app runtime', () => {
    asMac();
    mocks.app.isPackaged = false;
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('repairs stable protocol registration on Windows when packaged', () => {
    asWindows();
    mocks.app.isPackaged = true;
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledWith(DEEP_LINK_SCHEME);
  });

  it.each(['1', 'quiet'])('skips registration in e2e mode %s so tests never take over the system handler', (mode) => {
    asWindows();
    mocks.app.isPackaged = false;
    vi.stubEnv('KIMI_DESKTOP_E2E', mode);
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it.each(['1.1.1-canary.1', '1.1.1-preview.123.1.g12345678'])('does not replace stable registration for %s', (version) => {
    asWindows();
    mocks.app.getVersion.mockReturnValue(version);
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('swallows OS registration failures instead of crashing startup', () => {
    mocks.app.isPackaged = false;
    mocks.app.setAsDefaultProtocolClient.mockImplementationOnce(() => {
      throw new Error('registry write failed');
    });
    expect(() => registerDeepLinkScheme()).not.toThrow();
  });
});

describe('handleDeepLink', () => {
  it('shows the main window for the whitelisted auth-success URL', () => {
    const showMainWindow = vi.fn();
    handleDeepLink('kimi-code://auth/success', showMainWindow);
    expect(showMainWindow).toHaveBeenCalledOnce();
  });

  it('wakes the renderer after showing the window for a whitelisted URL', () => {
    const showMainWindow = vi.fn();
    const notifyAuth = vi.fn();
    handleDeepLink('kimi-code://auth/success', showMainWindow, notifyAuth);
    expect(notifyAuth).toHaveBeenCalledOnce();
    expect(showMainWindow.mock.invocationCallOrder[0]).toBeLessThan(
      notifyAuth.mock.invocationCallOrder[0]!,
    );
  });

  it('does not wake the renderer for an unknown URL', () => {
    const showMainWindow = vi.fn();
    const notifyAuth = vi.fn();
    handleDeepLink('kimi-code://unknown/path', showMainWindow, notifyAuth);
    expect(showMainWindow).not.toHaveBeenCalled();
    expect(notifyAuth).not.toHaveBeenCalled();
  });

  it('shows the main window for a case-variant of the whitelisted URL', () => {
    const showMainWindow = vi.fn();
    handleDeepLink('KIMI-CODE://AUTH/success', showMainWindow);
    expect(showMainWindow).toHaveBeenCalledOnce();
  });

  it('ignores unknown URLs', () => {
    const showMainWindow = vi.fn();
    handleDeepLink('kimi-code://unknown/path', showMainWindow);
    expect(showMainWindow).not.toHaveBeenCalled();
  });

  it('redacts query and fragment before logging an unknown URL', () => {
    handleDeepLink('kimi-code://unknown/path?code=secret#token=abc', vi.fn());
    expect(mocks.log.warn).toHaveBeenCalledWith(
      '[kimi-desktop] ignoring unknown deep link: kimi-code://unknown/path',
    );
  });
});

describe('workspace deep links', () => {
  it.each(['', '/'])('opens an encoded absolute workspace with pathname "%s"', (pathname) => {
    const root = resolve('项目 & a#b%');
    const show = vi.fn();
    const auth = vi.fn();
    const open = vi.fn();
    handleDeepLink(`kimi-code://open${pathname}?root=${encodeURIComponent(root)}&new=1`, show, auth, open);
    expect(show).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledExactlyOnceWith(root);
    expect(show.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
    expect(auth).not.toHaveBeenCalled();
  });

  it.each(['', 'relative', '../project'])('rejects invalid root %s', (root) => {
    expect(isKnownDeepLink(`kimi-code://open?root=${encodeURIComponent(root)}`)).toBe(false);
  });

  it.each(['', '&new=1'])('opens the decoded workspace without notifying auth %s', (suffix) => {
    const root = '/tmp/项目 & a#b%';
    const show = vi.fn();
    const auth = vi.fn();
    const open = vi.fn();
    handleDeepLink(`kimi-code://open?root=${encodeURIComponent(root)}${suffix}`, show, auth, open);
    expect(show).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(root);
    expect(auth).not.toHaveBeenCalled();
  });

  it.each([
    'kimi-code://open?root=/tmp&new=0',
    'kimi-code://open/extra?root=/tmp',
    'kimi-code://open?root=/tmp#fragment',
    'kimi-code://open?root=/tmp&root=/other',
    'kimi-code://open?root=/tmp%00',
    'kimi-code://user@open?root=/tmp',
    'https://open?root=/tmp',
    'kimi-code://open//?root=/tmp',
    'kimi-code://open/?root=relative',
    'kimi-code://open/?root=/tmp&new=0',
    'kimi-code://open/?root=/tmp#fragment',
    'kimi-code://open/?root=/tmp&root=/other',
    'kimi-code://open/?root=/tmp%00',
    'kimi-code://user@open/?root=/tmp',
  ])('ignores malformed workspace links: %s', (url) => {
    const show = vi.fn();
    const open = vi.fn();
    handleDeepLink(url, show, vi.fn(), open);
    expect(show).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
