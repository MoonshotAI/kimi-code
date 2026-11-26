import { app, BaseWindow, BrowserWindow } from 'electron';
import type { WebContents, WebContentsView } from 'electron';

import { e2eWindowMode } from '../app/e2e-mode';
import type { RendererEventChannel } from '../ipc/ipc-channels';

export interface MainWindow extends BaseWindow {
  readonly hostView: WebContentsView;
  readonly webContents: WebContents;
  loadURL(url: string): Promise<void>;
}

let mainWindow: MainWindow | null = null;

export function getMainWindow(): MainWindow | null {
  return mainWindow;
}

export function setMainWindow(win: MainWindow | null): void {
  mainWindow = win;
}

export function windowForWebContents(contents: WebContents): BaseWindow | null {
  if (mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.webContents === contents) return mainWindow;
  return BrowserWindow.fromWebContents(contents);
}

export function focusedWindowWebContents(): WebContents | undefined {
  const focused = BaseWindow.getFocusedWindow();
  if (focused === null || focused.isDestroyed()) return undefined;
  if (focused === mainWindow) return mainWindow.webContents;
  return focused instanceof BrowserWindow ? focused.webContents : undefined;
}

let isQuitting = false;
let quitConfirmSkipped = false;
let quitWatchInstalled = false;

export function installQuitWatch(): void {
  if (quitWatchInstalled) return;
  quitWatchInstalled = true;
  app.on('before-quit', () => {
    isQuitting = true;
  });
}

export function markQuitting(): void {
  isQuitting = true;
  quitConfirmSkipped = true;
}

export function isMarkedQuitting(): boolean {
  return isQuitting;
}

export function isQuitConfirmSkipped(): boolean {
  return quitConfirmSkipped || e2eWindowMode() !== null;
}

export function cancelQuitting(): void {
  isQuitting = false;
}

export function sendToRenderer(channel: RendererEventChannel, ...args: unknown[]): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (contents.isDestroyed() || contents.isCrashed()) return;
  try {
    contents.send(channel, ...args);
  } catch {
    return;
  }
}

const mainWindowGoneListeners = new Set<() => void>();

export function onMainWindowGone(listener: () => void): void {
  mainWindowGoneListeners.add(listener);
}

export function notifyMainWindowGone(): void {
  for (const listener of mainWindowGoneListeners) listener();
}

const mainWindowCloseInterceptors = new Set<() => boolean>();

export function addMainWindowCloseInterceptor(interceptor: () => boolean): void {
  mainWindowCloseInterceptors.add(interceptor);
}

export function shouldInterceptMainWindowClose(): boolean {
  for (const interceptor of mainWindowCloseInterceptors) {
    if (interceptor()) return true;
  }
  return false;
}
