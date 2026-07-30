// apps/web/src/lib/loginSource.ts
// Desktop-only marker appended to the OAuth device-flow verification URL: the
// authorization completion page reads `from=kimi_code_desktop` and renders the
// "open the desktop app" button (which deep-links `kimi-code://auth/success`)
// only for desktop-originated flows. No-op off the desktop app — the plain
// web UI and the CLI keep the bare URL, so the button stays hidden there.
// Not synced to apps/web (desktop divergence).

import { isDesktop } from './desktopFlag';

const DESKTOP_LOGIN_SOURCE = 'kimi_code_desktop';

/** Append `from=kimi_code_desktop` to the OAuth verification URL on the
    desktop (idempotent — `set` overwrites). Returns the input unchanged off
    the desktop and on unparseable URLs. */
export function withDesktopLoginSource(url: string): string {
  if (!isDesktop) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('from', DESKTOP_LOGIN_SOURCE);
    return parsed.toString();
  } catch {
    return url;
  }
}
