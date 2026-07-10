// apps/kimi-web/src/lib/desktopFlag.ts
//
// Detects whether the web UI is running inside the Kimi Desktop app, and on
// which platform.
//
// The desktop app shares the local kimi daemon with the CLI / browser / TUI, so
// the web bundle it displays may be served by an already-running external daemon
// (not the one bundled inside the app). A purely build-time flag is therefore
// unreliable. Instead, the desktop app appends `?kimi_desktop=1&platform=<os>`
// to the URL it loads (see apps/kimi-desktop/src/main/index.ts); we persist
// those values in sessionStorage so they survive any in-app navigation or
// redirect that drops the query string. The compile-time __KIMI_WEB_DESKTOP__
// is kept as an additional signal for the case where the web bundle itself was
// built for the desktop.

const QUERY_KEY = 'kimi_desktop';
const PLATFORM_KEY = 'platform';
const STORAGE_KEY = 'kimi-desktop';
const PLATFORM_STORAGE_KEY = 'kimi-desktop-platform';

interface DesktopEnv {
  isDesktop: boolean;
  platform: string | null;
}

function detect(): DesktopEnv {
  // `__KIMI_WEB_DESKTOP__` is injected by Vite `define`, but that replacement
  // is not applied in the dev server (see api/config.ts, which guards its own
  // defines the same way). Fall back to `false` so a plain browser dev session
  // doesn't throw a ReferenceError on startup; the runtime query-string /
  // sessionStorage signals below still detect the desktop app when present.
  let desktop = typeof __KIMI_WEB_DESKTOP__ !== 'undefined' ? __KIMI_WEB_DESKTOP__ : false;
  let platform: string | null = null;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has(QUERY_KEY)) {
      sessionStorage.setItem(STORAGE_KEY, '1');
      desktop = true;
    } else {
      desktop = desktop || sessionStorage.getItem(STORAGE_KEY) === '1';
    }
    const qPlatform = params.get(PLATFORM_KEY);
    if (qPlatform) {
      sessionStorage.setItem(PLATFORM_STORAGE_KEY, qPlatform);
      platform = qPlatform;
    } else {
      platform = sessionStorage.getItem(PLATFORM_STORAGE_KEY);
    }
  } catch {
    // sessionStorage may be unavailable (e.g. private mode) — fall back to the
    // compile-time flag only.
  }
  return { isDesktop: desktop, platform };
}

const env = detect();

/** True when running inside the Kimi Desktop app (any platform). */
export const isDesktop = env.isDesktop;

/** True only on macOS desktop — used to reserve space for the floating traffic
 *  lights when the window uses `titleBarStyle: 'hiddenInset'`. */
export const isMacosDesktop = env.isDesktop && env.platform === 'darwin';
