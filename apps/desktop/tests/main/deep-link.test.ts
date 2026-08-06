import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    setAsDefaultProtocolClient: vi.fn(),
  },
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('../../src/main/log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/log')>();
  return { ...actual, log: mocks.log };
});

import {
  DEEP_LINK_SCHEME,
  extractDeepLink,
  handleDeepLink,
  isKnownDeepLink,
  registerDeepLinkScheme,
} from '../../src/main/deep-link';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.app.isPackaged = true;
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
  });

  function asWindows(): void {
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
  }

  function asMac(): void {
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
  }

  it('no-ops in packaged builds on macOS/Linux (Info.plist / desktop file register it)', () => {
    asMac(); // the host runner may be Windows, where packaged builds self-register
    mocks.app.isPackaged = true;
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('registers the scheme for unpackaged dev launches', () => {
    mocks.app.isPackaged = false;
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      DEEP_LINK_SCHEME,
      process.execPath,
      [process.argv[1] ?? '.'],
    );
  });

  it('self-registers on Windows even when packaged (NSIS writes no registry entry)', () => {
    asWindows();
    mocks.app.isPackaged = true;
    registerDeepLinkScheme();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledWith(DEEP_LINK_SCHEME);
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
