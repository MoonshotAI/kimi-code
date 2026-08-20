import { app } from 'electron';

import { log, redactUrlForLog } from './log';

// OS-level deep link (`kimi-code://...`): the OAuth device-flow completion
// page links here so a successful browser authorization can surface the
// desktop window. No credentials ride the URL — the daemon's device-flow
// poll completes the login on its own and the renderer picks it up. Handling
// is therefore just "show the window" plus a wake nudge to the renderer, so
// its login poll runs immediately instead of waiting out the current
// server-suggested interval.
export const DEEP_LINK_SCHEME = 'kimi-code';

/** Whitelist check for incoming deep links. Any webpage can fire the scheme,
    so unknown or malformed URLs are dropped instead of acted on. Scheme and
    host compare case-insensitively (RFC 3986); the path stays case-sensitive. */
export function isKnownDeepLink(url: string): boolean {
  try {
    const parsed = new URL(url);
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

/** Find a deep link in a process argv. Windows/Linux deliver the URL as an
    argument — both in the cold-start argv and in second-instance argv. The
    scheme match is case-insensitive: an uppercased scheme is the same
    protocol and must not slip into the plain-relaunch path. */
export function extractDeepLink(argv: readonly string[]): string | undefined {
  const prefix = `${DEEP_LINK_SCHEME}://`;
  return argv.find((arg) => arg.toLowerCase().startsWith(prefix));
}

/** Register the scheme with the OS. Windows self-registers on every launch
    (packaged or not): electron-builder 26's `protocols` only lands in the
    macOS Info.plist, the Linux desktop file, and AppX manifests — NSIS
    installers get no registry entry at all, so the app must write
    HKCU\Software\Classes itself. Packaged macOS uses the Info.plist and the
    Linux deb uses the desktop file. macOS dev never registers: the call would
    claim the scheme for the bare Electron.app runtime in node_modules, which
    cannot route the URL to the actual app and only pollutes LaunchServices
    (every dev checkout would fight over the handler). */
export function registerDeepLinkScheme(): void {
  if (process.platform === 'darwin') return;
  const isWindows = process.platform === 'win32';
  if (!isWindows && app.isPackaged) return;
  try {
    // Packaged: register the app exe itself. Dev: re-launch as
    // `electron <app path> <url>` so the URL lands in the second-instance
    // argv on Windows/Linux.
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

/** Handle a validated deep link. Today every whitelisted URL means the same
    thing (auth finished in the browser): surface the main window, then notify
    the renderer so a waiting OAuth login flow polls the daemon right away.
    `notifyAuth` is optional only so tests and future call sites without a
    live renderer can opt out. */
export function handleDeepLink(
  url: string,
  showMainWindow: () => void,
  notifyAuth?: () => void,
): void {
  if (!isKnownDeepLink(url)) {
    // Redact before logging: the URL is attacker-controlled and a malformed
    // auth link could carry codes/tokens in its query or fragment.
    log.warn(`[kimi-desktop] ignoring unknown deep link: ${redactUrlForLog(url)}`);
    return;
  }
  showMainWindow();
  notifyAuth?.();
}
