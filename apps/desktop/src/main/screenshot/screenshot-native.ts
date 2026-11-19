import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { log } from '../diagnostics/log';

let native: { configure: (handle: Buffer) => string; configurePin: (handle: Buffer) => void } | undefined;
interface NativeScreenshotFrame { displayId: string; png: Buffer; width: number; height: number }
let captureNative: { capture: (mode: number) => Promise<NativeScreenshotFrame[]> } | undefined;

function nativeDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'screenshot-window-list')
    : join(app.getAppPath(), 'native', 'screenshot-window-list', 'dist');
}

function windowsOverlayHwnd(window: BrowserWindow): string {
  const handle = window.getNativeWindowHandle();
  return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString(10);
}

function windowsOverlayExecutable(): string {
  return join(nativeDirectory(), 'screenshot-window-list.exe');
}

export async function captureNativeScreenshotFrames(mode: 'default' | 'display-shadows' | 'all-shadows' = 'all-shadows'): Promise<NativeScreenshotFrame[]> {
  if (process.platform !== 'darwin') throw new Error('native-capture-unsupported');
  if (captureNative === undefined) {
    captureNative = createRequire(import.meta.url)(join(nativeDirectory(), 'screenshot-capture.node')) as typeof captureNative;
  }
  return captureNative!.capture(['default', 'display-shadows', 'all-shadows'].indexOf(mode));
}

export function configureScreenshotOverlay(window: BrowserWindow): string | undefined | Promise<string> {
  if (process.platform === 'win32') {
    const hwnd = windowsOverlayHwnd(window);
    return new Promise((resolve, reject) => {
      const child = execFile(windowsOverlayExecutable(), ['configure', hwnd, String(process.pid)], { timeout: 2_000, windowsHide: true }, (error, stdout) => {
        window.removeListener('closed', cancel);
        if (error !== null) reject(error);
        else {
          log.info(`[screenshot] native-window=${hwnd} ${stdout.trim()}`);
          resolve(hwnd);
        }
      });
      const cancel = (): void => { child.kill(); };
      window.once('closed', cancel);
    });
  }
  if (process.platform !== 'darwin') return undefined;
  return windowNative().configure(window.getNativeWindowHandle());
}

function windowNative(): NonNullable<typeof native> {
  if (native === undefined) {
    native = createRequire(import.meta.url)(join(nativeDirectory(), 'screenshot-overlay.node')) as typeof native;
  }
  return native!;
}

export function configurePinnedScreenshot(window: BrowserWindow): void {
  if (process.platform === 'darwin') windowNative().configurePin(window.getNativeWindowHandle());
}
