import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, screen, type BrowserWindow } from 'electron';
import type { DisplayLike, RegionRect } from './controller';
import { log } from '../diagnostics/log';

let native: { configure: (handle: Buffer) => string; configurePin: (handle: Buffer) => void } | undefined;
interface NativeScreenshotFrame { displayId: string; png: Buffer; width: number; height: number }
let captureNative: { capture: (mode: number) => Promise<NativeScreenshotFrame[]> } | undefined;

export interface WindowsOverlayPlacement {
  id: string;
  monitor: RegionRect;
}

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

function isPixelRect(value: unknown): value is RegionRect {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  return [x, y, width, height].every((part) => Number.isInteger(part)) && (width as number) > 0 && (height as number) > 0;
}

function placementMonitor(stdout: string): RegionRect | null {
  try {
    const { monitor } = JSON.parse(stdout) as { monitor?: unknown };
    return isPixelRect(monitor) ? { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height } : null;
  } catch {
    return null;
  }
}

export function configureScreenshotOverlay(window: BrowserWindow, display: Pick<DisplayLike, 'bounds'>): string | undefined | Promise<WindowsOverlayPlacement> {
  if (process.platform === 'win32') {
    const hwnd = windowsOverlayHwnd(window);
    const { x, y, width, height } = display.bounds;
    const anchor = screen.dipToScreenPoint({ x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) });
    return new Promise((resolve, reject) => {
      const args = ['configure', hwnd, String(process.pid), String(anchor.x), String(anchor.y)];
      const child = execFile(windowsOverlayExecutable(), args, { timeout: 2_000, windowsHide: true }, (error, stdout) => {
        window.removeListener('closed', cancel);
        if (error !== null) {
          reject(error);
          return;
        }
        log.info(`[screenshot] native-window=${hwnd} ${stdout.trim()}`);
        const monitor = placementMonitor(stdout.trim());
        if (monitor === null) reject(new Error('overlay-placement-unreadable'));
        else resolve({ id: hwnd, monitor });
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
