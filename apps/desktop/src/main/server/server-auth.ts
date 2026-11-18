import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { loadOrCreateServerToken, serverTokenPath } from '@moonshot-ai/kap-server';
import type { Session, WebContents } from 'electron';

let launchSecret: string | undefined;

export function desktopServerSecret(): string {
  launchSecret ??= randomBytes(32).toString('base64url');
  return launchSecret;
}

function timingSafeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDesktopAuthTokenService(homeDir: string): {
  readonly _serviceBrand: undefined;
  getToken(): string;
  isValid(candidate: string): Promise<boolean>;
} {
  const tokenPath = serverTokenPath(homeDir);
  void loadOrCreateServerToken(homeDir).catch(() => {});
  const secret = desktopServerSecret();
  let cache: { token: string; mtimeMs: number; ino: number } | undefined;
  const currentToken = (): string | undefined => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(tokenPath);
    } catch {
      cache = undefined;
      return undefined;
    }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      cache = undefined;
      return undefined;
    }
    if (cache !== undefined && st.mtimeMs === cache.mtimeMs && st.ino === cache.ino) {
      return cache.token;
    }
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      if (token.length > 0) {
        cache = { token, mtimeMs: st.mtimeMs, ino: st.ino };
      }
    } catch {
    }
    return cache?.token;
  };
  return {
    _serviceBrand: undefined,
    getToken: () => currentToken() ?? '',
    isValid: (candidate: string) => {
      if (timingSafeMatch(candidate, secret)) return Promise.resolve(true);
      const token = currentToken();
      return Promise.resolve(token !== undefined && timingSafeMatch(candidate, token));
    },
  };
}

let embeddedOrigin: string | undefined;

export function setEmbeddedServerOrigin(origin: string | undefined): void {
  embeddedOrigin = origin;
}

const appWebContents = new Set<number>();

export function registerAppWebContents(contents: WebContents): void {
  appWebContents.add(contents.id);
  contents.once('destroyed', () => {
    appWebContents.delete(contents.id);
  });
}

function isEmbeddedServerUrl(url: string, origin: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(origin);
  } catch {
    return false;
  }
  if (target.host !== base.host) return false;
  return (
    target.protocol === 'http:' ||
    target.protocol === 'https:' ||
    target.protocol === 'ws:' ||
    target.protocol === 'wss:'
  );
}

const injectedSessions = new WeakSet<Session>();

export function installEmbeddedServerAuthInjection(ses: Session): void {
  if (injectedSessions.has(ses)) return;
  injectedSessions.add(ses);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const origin = embeddedOrigin;
    const contents = details.webContents;
    if (
      origin !== undefined &&
      contents !== undefined &&
      appWebContents.has(contents.id) &&
      isEmbeddedServerUrl(details.url, origin)
    ) {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Authorization: `Bearer ${desktopServerSecret()}`,
        },
      });
      return;
    }
    callback({});
  });
}
