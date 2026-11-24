import { isAbsolute } from 'node:path';

import { app } from 'electron';

import { e2eWindowMode } from './e2e-mode';
import { log, redactUrlForLog } from '../diagnostics/log';
import { isCanaryVersion, isPreviewVersion } from '../release/release-channel';

export const DEEP_LINK_SCHEME = 'kimi-code';

const SESSION_PATH = /^\/([A-Za-z0-9_-]{1,128})$/;

function deepLinkSessionId(parsed: URL): string | null {
  if (parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') return null;
  return SESSION_PATH.exec(parsed.pathname)?.[1] ?? null;
}

export function isKnownDeepLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${DEEP_LINK_SCHEME}:` && parsed.host.toLowerCase() === 'sessions') {
      return deepLinkSessionId(parsed) !== null;
    }
    if (parsed.protocol === `${DEEP_LINK_SCHEME}:` && parsed.host.toLowerCase() === 'open') {
      const root = parsed.searchParams.get('root');
      return (
        root !== null &&
        isAbsolute(root) &&
        !root.includes('\0') &&
        (parsed.pathname === '' || parsed.pathname === '/') &&
        parsed.hash === '' &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.searchParams.getAll('root').length === 1 &&
        (parsed.searchParams.get('new') === null || parsed.searchParams.get('new') === '1')
      );
    }
    return (
      parsed.protocol === `${DEEP_LINK_SCHEME}:` &&
      parsed.host.toLowerCase() === 'auth' &&
      parsed.pathname === '/success' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

export function extractDeepLink(argv: readonly string[]): string | undefined {
  const prefix = `${DEEP_LINK_SCHEME}://`;
  return argv.find((arg) => arg.toLowerCase().startsWith(prefix));
}

export function registerDeepLinkScheme(): void {
  const version = app.getVersion();
  if (isCanaryVersion(version) || isPreviewVersion(version)) return;
  if (process.platform === 'darwin') return;
  if (e2eWindowMode() !== null) return;
  const isWindows = process.platform === 'win32';
  if (!isWindows && app.isPackaged) return;
  try {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    } else {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        process.argv[1] ?? '.',
      ]);
    }
  } catch (error) {
    log.error('[kimi-desktop] deep link scheme registration failed', error);
  }
}

export function handleDeepLink(
  url: string,
  showMainWindow: () => void,
  notifyAuth?: () => void,
  openWorkspace?: (root: string) => void,
  openSession?: (sessionId: string) => void,
): void {
  if (!isKnownDeepLink(url)) {
    log.warn(`[kimi-desktop] ignoring unknown deep link: ${redactUrlForLog(url)}`);
    return;
  }
  showMainWindow();
  const parsed = new URL(url);
  const host = parsed.host.toLowerCase();
  if (host === 'sessions') {
    openSession?.(deepLinkSessionId(parsed)!);
  } else if (host === 'open') {
    openWorkspace?.(parsed.searchParams.get('root')!);
  } else {
    notifyAuth?.();
  }
}
