import { dirname, join } from 'node:path';

import type { Session } from 'electron';

// Download manager. Renderer exports (session zip, debug trace logs) are web-
// style blob downloads; without a handler, whatever Electron happens to do by
// default is what the user gets. Here we make the flow explicit: every
// download prompts a native save dialog (pre-filled with the last used
// directory + suggested filename), writes only to the chosen path, and a
// cancelled dialog means nothing lands on disk. Covers every current and
// future download entry with zero renderer changes.
//
// Dependencies are injected so the logic is testable without Electron.

export interface DownloadDeps {
  /** Native save dialog; resolves the chosen absolute path, or undefined on cancel. */
  showSaveDialog: (opts: { defaultPath: string }) => string | undefined;
  /** Starting directory before the user has chosen one this app run. */
  downloadsDir: string;
}

// Guard against double-install on the same session: macOS re-creates windows
// on `activate`, and each install would stack another `will-download`
// listener (→ stacked save dialogs).
const installedSessions = new WeakSet<object>();

export function installDownloadHandler(session: Session, deps: DownloadDeps): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);

  // In-memory only: resets to downloadsDir on the next app run.
  let lastDir = deps.downloadsDir;

  session.on('will-download', (_event, item) => {
    const target = deps.showSaveDialog({ defaultPath: join(lastDir, item.getFilename()) });
    if (!target) {
      item.cancel();
      return;
    }
    item.setSavePath(target);
    lastDir = dirname(target);
  });
}
