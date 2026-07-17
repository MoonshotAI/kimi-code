import { join } from 'node:path';

import { app, Menu, nativeImage, Tray } from 'electron';

// System tray (macOS menu-bar / Windows notification area). Desktop-only — the
// web client has no equivalent surface. A single context menu covers both
// interactions: on macOS a plain click on a status item with a context menu
// opens the menu; on Windows left-click is wired to the same menu below.

export interface TrayIconEnv {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** <resources> in packaged builds (extraResources carries build/tray*). */
  resourcesPath: string;
  /** Repo dir in dev (Electron launched with cwd = apps/desktop). */
  appPath: string;
}

/** Tray icon file. macOS uses a monochrome template image — the `Template` in
    the filename makes nativeImage mark it automatically, and the OS re-colors
    the silhouette to match light/dark menu bars. Windows wants .ico; Linux
    uses the color png (retina tray@2x.png is picked up automatically). */
export function trayIconPath(env: TrayIconEnv): string {
  const name =
    env.platform === 'darwin'
      ? 'trayTemplate.png'
      : env.platform === 'win32'
        ? 'tray.ico'
        : 'tray.png';
  return join(env.isPackaged ? env.resourcesPath : env.appPath, 'build', name);
}

export interface TrayActions {
  /** Show (recreating if closed) and focus the main window. */
  showMainWindow(): void;
  /** Quit via app.quit() so before-quit cleanup (server handle) still runs. */
  quit(): void;
}

export function createTray(actions: TrayActions): Tray | null {
  const iconPath = trayIconPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const image = nativeImage.createFromPath(iconPath);
  // A missing asset yields an empty image, and `new Tray()` on it would throw
  // inside the whenReady chain — silently killing the tray AND every
  // statement after it. Degrade loudly instead. (2026-07: a broken
  // extraResources glob did exactly this — assets never shipped, no tray.)
  if (image.isEmpty()) {
    console.warn('[tray] icon not found, tray disabled:', iconPath);
    return null;
  }
  // The macOS asset is an all-white silhouette: hand it to the system as a
  // template image so the menu bar recolors it (black on light themes, white
  // on dark). Windows/Linux keep their colored icon as-is.
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  const tray = new Tray(image);
  tray.setToolTip('Kimi Code');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => actions.showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => actions.quit() },
    ]),
  );
  if (process.platform === 'win32') {
    tray.on('click', () => tray.popUpContextMenu());
  }
  return tray;
}
