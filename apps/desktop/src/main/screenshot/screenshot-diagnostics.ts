import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, desktopCapturer, nativeImage, screen, systemPreferences } from 'electron';
import { captureNativeScreenshotFrames, configureScreenshotOverlay } from './screenshot-native';
import { registerRendererProtocol } from '../app/protocol';
import { listScreenshotWindows } from './screenshot-windows';
import { encodeScreenshotBitmap, screenshotBitmapFrame } from './screenshot-frame';
import { findSingleDisplaySourceFallback } from './screenshot-source';

function edgeDifference(page: Electron.NativeImage, desktop: Electron.NativeImage): number {
  const { width, height } = page.getSize();
  const other = desktop.getSize();
  if (width !== other.width || height !== other.height) return 1;
  const pixels = page.toBitmap();
  const screenPixels = desktop.toBitmap();
  let compared = 0;
  let different = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= 8 && x < width - 8 && y >= 8 && y < height - 8) continue;
      const offset = (y * width + x) * 4;
      compared++;
      if ([0, 1, 2].some((channel) => Math.abs(pixels[offset + channel]! - screenPixels[offset + channel]!) > 3)) different++;
    }
  }
  return different / compared;
}

export async function runScreenshotDiagnostics(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'kimi-screenshot-diagnostics-'));
  app.setPath('userData', join(directory, 'user-data'));
  await app.whenReady();
  app.on('window-all-closed', () => {});
  let exitCode = 0;
  const fixtures: BrowserWindow[] = [];
  try {
    const permission = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
    if (permission !== 'granted') throw new Error(`screen-permission:${permission}`);
    const displays = screen.getAllDisplays();
    if (process.argv.includes('--screenshot-diagnostics-fixture')) {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const origin = { x: display.workArea.x + 40, y: display.workArea.y + 40 };
      for (const [index, rect] of [
        { ...origin, width: 600, height: 500 },
        { x: origin.x + 140, y: origin.y + 110, width: 300, height: 220 },
      ].entries()) {
        const window = new BrowserWindow({ ...rect, show: false, frame: index === 1, hasShadow: index === 1, backgroundColor: '#ffffff', title: 'Screenshot diagnostics', webPreferences: { sandbox: true } });
        fixtures.push(window);
        if (process.platform === 'darwin') await configureScreenshotOverlay(window);
        await window.loadURL('data:text/html,<html><body></body></html>');
        window.show();
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const maxEdge = Math.max(...displays.map((display) => Math.max(display.bounds.width, display.bounds.height) * display.scaleFactor));
    const results: Array<{ mode: string; durationMs: number; sourceDurationMs?: number; encodingDurationMs?: number; pixelsEqual?: boolean; frames: Array<{ displayId: string; width: number; height: number; file: string }>; error?: string }> = [];
    const modes = process.platform === 'darwin' ? ['all-shadows', 'electron', 'default', 'display-shadows'] as const
      : process.platform === 'win32' ? ['electron', 'electron-fast', 'electron-bitmap'] as const : ['electron'] as const;
    const candidates = await listScreenshotWindows(displays);
    if (process.platform === 'win32') {
      for (const fixture of fixtures) {
        const handle = fixture.getNativeWindowHandle();
        const id = (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
        if (![...candidates.values()].some((windows) => windows.some((window) => window.id === id))) throw new Error('diagnostics-own-window-missing');
      }
    }
    const overlays: Array<{ durationMs: number; frames: Array<{ bounds: Electron.Rectangle; contentBounds: Electron.Rectangle; viewport: { width: number; height: number }; native: unknown; edgeDifference: number; file: string; desktopFile: string }> }> = [];
    if (process.argv.includes('--screenshot-diagnostics-overlay')) {
      registerRendererProtocol(() => app.isPackaged ? join(process.resourcesPath, 'desktop-dist') : join(app.getAppPath(), 'desktop-dist'));
      const { initScreenshot, captureScreenshot, cancelScreenshotCapture } = await import('./controller');
      initScreenshot();
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt === 2) await new Promise((resolve) => setTimeout(resolve, 1_800));
        const start = performance.now();
        const capture = captureScreenshot();
        try {
          let windows: BrowserWindow[] = [];
          while (performance.now() - start < 10_000) {
            windows = BrowserWindow.getAllWindows().filter((window) => !fixtures.includes(window) && window.isVisible());
            if (windows.length === displays.length) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (windows.length !== displays.length) throw new Error('diagnostics-overlay-timeout');
          const durationMs = Math.round(performance.now() - start);
          await new Promise((resolve) => setTimeout(resolve, 150));
          const frames = [];
          for (const [index, window] of windows.entries()) {
            const displayId = new URL(window.webContents.getURL()).searchParams.get('display');
            const display = displays.find((item) => String(item.id) === displayId)!;
            const contentBounds = window.getContentBounds();
            let native: unknown;
            if (process.platform === 'win32') {
              const handle = window.getNativeWindowHandle();
              const hwnd = (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
              const executable = app.isPackaged ? join(process.resourcesPath, 'screenshot-window-list', 'screenshot-window-list.exe') : join(app.getAppPath(), 'native', 'screenshot-window-list', 'dist', 'screenshot-window-list.exe');
              const { stdout } = await promisify(execFile)(executable, ['inspect', hwnd, String(process.pid)], { windowsHide: true, timeout: 2_000 });
              const inspection = JSON.parse(stdout) as { covered: boolean };
              native = inspection;
              if (!inspection.covered) exitCode = 1;
            }
            const viewport = await window.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })') as { width: number; height: number };
            if (contentBounds.x !== display.bounds.x || contentBounds.y !== display.bounds.y || contentBounds.width !== display.bounds.width || contentBounds.height !== display.bounds.height
              || viewport.width !== display.bounds.width || viewport.height !== display.bounds.height) throw new Error('diagnostics-overlay-bounds-mismatch');
            const file = `overlay-${attempt}-${index}.png`;
            const page = await window.webContents.capturePage();
            const png = page.toPNG();
            await writeFile(join(directory, file), png, { flag: 'wx', mode: 0o600 });
            const desktop = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: page.getSize() });
            const desktopSource = desktop.find((source) => source.display_id === displayId) ?? findSingleDisplaySourceFallback(desktop, displays.length);
            if (desktopSource === undefined) throw new Error('diagnostics-desktop-frame-missing');
            const desktopFrame = desktopSource.thumbnail;
            const desktopFile = `desktop-${attempt}-${index}.png`;
            await writeFile(join(directory, desktopFile), desktopFrame.toPNG(), { flag: 'wx', mode: 0o600 });
            const difference = edgeDifference(nativeImage.createFromBuffer(png), desktopFrame);
            if (difference > 0.01) exitCode = 1;
            frames.push({ bounds: window.getBounds(), contentBounds, viewport, native, edgeDifference: difference, file, desktopFile });
          }
          overlays.push({ durationMs, frames });
        } finally {
          cancelScreenshotCapture();
          await capture;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    for (const mode of modes) {
      const start = performance.now();
      try {
        let sourceDurationMs: number | undefined;
        let encodingDurationMs: number | undefined;
        let captured: Electron.DesktopCapturerSource[] | undefined;
        let frames: Array<{ displayId: string; data: Buffer }>;
        if (mode === 'electron' || mode === 'electron-fast' || mode === 'electron-bitmap') {
          captured = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxEdge, height: maxEdge } });
          sourceDurationMs = Math.round(performance.now() - start);
          const encodingStart = performance.now();
          frames = await Promise.all(captured.map(async (source) => {
            const size = source.thumbnail.getSize();
            const data = mode === 'electron-bitmap'
              ? screenshotBitmapFrame(source.thumbnail.toBitmap(), size.width, size.height)
              : mode === 'electron-fast'
                ? await encodeScreenshotBitmap(source.thumbnail.toBitmap(), size.width, size.height)
                : source.thumbnail.toPNG();
            return { displayId: source.display_id, data };
          }));
          encodingDurationMs = Math.round(performance.now() - encodingStart);
        } else frames = (await captureNativeScreenshotFrames(mode)).map(({ displayId, png }) => ({ displayId, data: png }));
        const durationMs = Math.round(performance.now() - start);
        let pixelsEqual: boolean | undefined = mode === 'electron-fast' || mode === 'electron-bitmap' ? true : undefined;
        const files = [];
        for (const [index, frame] of frames.entries()) {
          const file = `${mode}-${index}.${mode === 'electron-bitmap' ? 'bmp' : 'png'}`;
          await writeFile(join(directory, file), frame.data, { flag: 'wx', mode: 0o600 });
          let decoded: Electron.NativeImage;
          if (mode === 'electron-bitmap') {
            const decoder = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
            try {
              await decoder.loadFile(join(directory, file));
              const png = await decoder.webContents.executeJavaScript(`(async () => {
                const image = document.querySelector('img');
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                canvas.getContext('2d').drawImage(image, 0, 0);
                return canvas.toDataURL('image/png');
              })()`) as string;
              decoded = nativeImage.createFromDataURL(png);
            } finally {
              decoder.destroy();
            }
          } else decoded = nativeImage.createFromBuffer(frame.data);
          if (pixelsEqual !== undefined) pixelsEqual &&= decoded.toBitmap().equals(nativeImage.createFromBuffer(captured![index]!.thumbnail.toPNG()).toBitmap());
          files.push({ displayId: frame.displayId, ...decoded.getSize(), file });
        }
        if (pixelsEqual === false) exitCode = 1;
        results.push({ mode, durationMs, sourceDurationMs, encodingDurationMs, pixelsEqual, frames: files });
      } catch (error) {
        exitCode = 1;
        results.push({ mode, durationMs: Math.round(performance.now() - start), frames: [], error: error instanceof Error ? error.message : String(error) });
      }
    }
    const report = { electron: process.versions.electron, chrome: process.versions.chrome, fixtures: fixtures.map((window) => window.getBounds()), displays: displays.map(({ id, bounds, scaleFactor }) => ({ id, bounds, scaleFactor })), results, overlays };
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ directory, ...report })}\n`);
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    for (const window of fixtures) if (!window.isDestroyed()) window.destroy();
    app.exit(exitCode);
  }
}
