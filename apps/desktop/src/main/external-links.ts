import type { WebContents } from 'electron';

// External-link guard. The renderer is a web UI full of `window.open` /
// `target="_blank"` links (PR pages, OAuth device flow, downloads, Markdown
// anchors). Without a window-open handler, Electron opens those in a
// frameless managed BrowserWindow instead of the user's browser. These
// deciders route external http(s) to the system browser and keep everything
// else out of new windows.
//
// Pure + dependency-injected so the logic is testable without Electron.

export type LinkAction = 'allow' | 'open-external' | 'deny';

export function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** What to do when the renderer calls `window.open` / clicks `target="_blank"`. */
export function decideWindowOpen(url: string): LinkAction {
  // Blank popups stay real windows: the debug panel mounts its own Vue app
  // into a popup document and needs live DOM access to it.
  if (url === '' || url === 'about:blank') return 'allow';
  if (isHttpUrl(url)) return 'open-external';
  // Internal schemes (app:, file:, javascript:, …) never get a new window.
  return 'deny';
}

/** What to do when the main window itself is about to navigate. */
export function decideNavigation(currentUrl: string, targetUrl: string): LinkAction {
  // Cross-origin http(s) must not replace the app UI — send it to the
  // browser. Same-origin http (dev-server reloads / HMR) and internal
  // schemes proceed normally.
  if (isHttpUrl(targetUrl) && originOf(targetUrl) !== originOf(currentUrl)) {
    return 'open-external';
  }
  return 'allow';
}

/** Wires the guard onto a webContents. `openExternal` is injected for tests;
 *  production callers pass `shell.openExternal`. */
export function installExternalLinkGuard(
  contents: WebContents,
  openExternal: (url: string) => Promise<void>,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    const action = decideWindowOpen(url);
    if (action === 'open-external') {
      void openExternal(url);
      return { action: 'deny' as const };
    }
    // 'allow' is only ever returned for blank popups; 'deny' covers the rest.
    return action === 'allow' ? { action: 'allow' as const } : { action: 'deny' as const };
  });
  contents.on('will-navigate', (event, url) => {
    if (decideNavigation(contents.getURL(), url) === 'open-external') {
      event.preventDefault();
      void openExternal(url);
    }
  });
}
