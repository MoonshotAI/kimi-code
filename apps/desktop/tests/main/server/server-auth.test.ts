import { mkdtempSync, rmSync, writeFileSync, chmodSync, utimesSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/kap-server', () => ({
  serverTokenPath: (homeDir: string) => join(homeDir, 'server.token'),
  loadOrCreateServerToken: async (homeDir: string) => {
    const tokenPath = join(homeDir, 'server.token');
    try {
      const existing = readFileSync(tokenPath, 'utf8').trim();
      if (existing.length > 0) return existing;
    } catch {}
    const token = 'mock-generated-token';
    writeFileSync(tokenPath, token, { mode: 0o600 });
    return token;
  },
}));

import {
  createDesktopAuthTokenService,
  desktopServerSecret,
  installEmbeddedServerAuthInjection,
  registerAppWebContents,
  setEmbeddedServerOrigin,
} from '../../../src/main/server/server-auth';

const EMBEDDED_ORIGIN = 'http://127.0.0.1:54321';

interface FakeSession {
  listener: ((details: unknown, callback: (response: unknown) => void) => void) | undefined;
}

function fakeSession(): { session: FakeSession; install: () => void } {
  const fake: FakeSession = { listener: undefined };
  const electronSession = {
    webRequest: {
      onBeforeSendHeaders: (listener: FakeSession['listener']) => {
        fake.listener = listener;
      },
    },
  } as never;
  return {
    session: fake,
    install: () => {
      installEmbeddedServerAuthInjection(electronSession);
    },
  };
}

function fakeWebContents(id: number): { id: number; destroyed: () => void; once: (event: string, cb: () => void) => void } {
  let onDestroyed: (() => void) | undefined;
  return {
    id,
    once: (_event: string, cb: () => void) => {
      onDestroyed = cb;
    },
    destroyed: () => onDestroyed?.(),
  };
}

function requestHeader(
  fake: FakeSession,
  details: { url: string; webContents?: { id: number } },
): { url: string; headers: Record<string, string> } {
  let response: { requestHeaders?: Record<string, string> } = {};
  fake.listener?.(
    { url: details.url, webContents: details.webContents, requestHeaders: { 'X-Test': '1' } },
    (res: unknown) => {
      response = res as { requestHeaders?: Record<string, string> };
    },
  );
  return { url: details.url, headers: response.requestHeaders ?? {} };
}

describe('installEmbeddedServerAuthInjection', () => {
  beforeEach(() => {
    setEmbeddedServerOrigin(EMBEDDED_ORIGIN);
  });

  afterEach(() => {
    setEmbeddedServerOrigin(undefined);
  });

  it('adds the bearer secret for an app webContents calling the embedded origin over HTTP', () => {
    const { session, install } = fakeSession();
    install();
    const contents = fakeWebContents(1);
    registerAppWebContents(contents as never);

    const res = requestHeader(session, { url: `${EMBEDDED_ORIGIN}/api/v1/sessions`, webContents: contents });
    expect(res.headers['Authorization']).toBe(`Bearer ${desktopServerSecret()}`);
    expect(res.headers['X-Test']).toBe('1');
  });

  it('adds the bearer secret to the WebSocket upgrade against the embedded origin', () => {
    const { session, install } = fakeSession();
    install();
    const contents = fakeWebContents(2);
    registerAppWebContents(contents as never);

    const wsUrl = `ws://127.0.0.1:54321/api/v1/ws`;
    const res = requestHeader(session, { url: wsUrl, webContents: contents });
    expect(res.headers['Authorization']).toBe(`Bearer ${desktopServerSecret()}`);
  });

  it('does not inject for requests to other origins', () => {
    const { session, install } = fakeSession();
    install();
    const contents = fakeWebContents(3);
    registerAppWebContents(contents as never);

    const res = requestHeader(session, { url: 'https://example.com/api/v1/sessions', webContents: contents });
    expect(res.headers['Authorization']).toBeUndefined();
    expect(res.headers['X-Test']).toBeUndefined();
  });

  it('does not inject for a webContents that is not an app window', () => {
    const { session, install } = fakeSession();
    install();
    const browserTab = fakeWebContents(99);

    const res = requestHeader(session, { url: `${EMBEDDED_ORIGIN}/api/v1/sessions`, webContents: browserTab });
    expect(res.headers['Authorization']).toBeUndefined();
  });

  it('does not inject when there is no webContents at all', () => {
    const { session, install } = fakeSession();
    install();

    const res = requestHeader(session, { url: `${EMBEDDED_ORIGIN}/api/v1/sessions` });
    expect(res.headers['Authorization']).toBeUndefined();
  });

  it('stops injecting for a destroyed webContents', () => {
    const { session, install } = fakeSession();
    install();
    const contents = fakeWebContents(4);
    registerAppWebContents(contents as never);
    contents.destroyed();

    const res = requestHeader(session, { url: `${EMBEDDED_ORIGIN}/api/v1/sessions`, webContents: contents });
    expect(res.headers['Authorization']).toBeUndefined();
  });

  it('does nothing while the embedded origin is not set', () => {
    setEmbeddedServerOrigin(undefined);
    const { session, install } = fakeSession();
    install();
    const contents = fakeWebContents(5);
    registerAppWebContents(contents as never);

    const res = requestHeader(session, { url: `${EMBEDDED_ORIGIN}/api/v1/sessions`, webContents: contents });
    expect(res.headers['Authorization']).toBeUndefined();
  });

  it('installs the listener only once per session', () => {
    const { session, install } = fakeSession();
    install();
    const first = session.listener;
    install();
    expect(session.listener).toBe(first);
  });
});

describe('createDesktopAuthTokenService', () => {
  let homeDir: string;
  let tokenPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-server-auth-'));
    tokenPath = join(homeDir, 'server.token');
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeToken(token: string, mode = 0o600): void {
    writeFileSync(tokenPath, token, { mode });
    chmodSync(tokenPath, mode);
  }

  it('creates the shared token file when missing and accepts it alongside the secret', async () => {
    const service = createDesktopAuthTokenService(homeDir);
    const token = service.getToken();
    expect(token.length).toBeGreaterThan(0);
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token);
    await expect(service.isValid(token)).resolves.toBe(true);
    await expect(service.isValid(desktopServerSecret())).resolves.toBe(true);
    await expect(service.isValid('some-other-token')).resolves.toBe(false);
  });

  it.skipIf(process.platform === 'win32')('creates the shared token file with private permissions', () => {
    createDesktopAuthTokenService(homeDir);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('accepts the persisted server token alongside the secret', async () => {
    writeToken('server-token-1');
    const service = createDesktopAuthTokenService(homeDir);
    await expect(service.isValid('server-token-1')).resolves.toBe(true);
    await expect(service.isValid(desktopServerSecret())).resolves.toBe(true);
    await expect(service.isValid('server-token-2')).resolves.toBe(false);
    expect(service.getToken()).toBe('server-token-1');
  });

  it('follows a token rotation without invalidating the per-launch secret', async () => {
    writeToken('server-token-1');
    const service = createDesktopAuthTokenService(homeDir);
    await expect(service.isValid('server-token-1')).resolves.toBe(true);

    writeToken('rotated-token');
    utimesSync(tokenPath, new Date(), new Date(Date.now() + 5_000));

    await expect(service.isValid('rotated-token')).resolves.toBe(true);
    await expect(service.isValid('server-token-1')).resolves.toBe(false);
    await expect(service.isValid(desktopServerSecret())).resolves.toBe(true);
    expect(service.getToken()).toBe('rotated-token');
  });

  it('drops the cached token when the token file is deleted', async () => {
    writeToken('cached-token');
    const service = createDesktopAuthTokenService(homeDir);
    await expect(service.isValid('cached-token')).resolves.toBe(true);

    rmSync(tokenPath);
    await expect(service.isValid('cached-token')).resolves.toBe(false);
    expect(service.getToken()).toBe('');
    await expect(service.isValid(desktopServerSecret())).resolves.toBe(true);

    writeToken('recreated-token');
    await expect(service.isValid('recreated-token')).resolves.toBe(true);
    await expect(service.isValid('cached-token')).resolves.toBe(false);
  });

  it.skipIf(process.platform === 'win32')('ignores a token file that is readable by group or others', async () => {
    writeToken('world-readable-token', 0o644);
    const service = createDesktopAuthTokenService(homeDir);
    await expect(service.isValid('world-readable-token')).resolves.toBe(false);
    await expect(service.isValid(desktopServerSecret())).resolves.toBe(true);
  });

  it.skipIf(process.platform === 'win32')('drops the cached token the moment the file turns permissive', async () => {
    writeToken('cached-token', 0o600);
    const service = createDesktopAuthTokenService(homeDir);
    await expect(service.isValid('cached-token')).resolves.toBe(true);

    chmodSync(tokenPath, 0o644);
    await expect(service.isValid('cached-token')).resolves.toBe(false);
    expect(service.getToken()).toBe('');

    chmodSync(tokenPath, 0o600);
    await expect(service.isValid('cached-token')).resolves.toBe(true);
  });

  it('trims whitespace around the persisted token', async () => {
    writeToken('  padded-token\n');
    const service = createDesktopAuthTokenService(homeDir);
    await expect(service.isValid('padded-token')).resolves.toBe(true);
    expect(service.getToken()).toBe('padded-token');
  });
});
