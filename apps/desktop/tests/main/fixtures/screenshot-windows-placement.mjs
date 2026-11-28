import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { app, BrowserWindow, desktopCapturer, screen } from 'electron';

const run = promisify(execFile);
const executable = fileURLToPath(new URL('../../../native/screenshot-window-list/dist/screenshot-window-list.exe', import.meta.url));
const hwnd = (window) => window.getNativeWindowHandle().readBigUInt64LE().toString();
const helper = async (args) => JSON.parse((await run(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000 })).stdout);

void app.whenReady().then(async () => {
  try {
    assert.equal(process.platform, 'win32');
    const display = screen.getPrimaryDisplay();
    const overlay = new BrowserWindow({
      ...display.bounds,
      frame: false,
      thickFrame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#000000',
    });
    overlay.setBounds(display.bounds, false);
    overlay.setAlwaysOnTop(true, 'screen-saver');
    const { x, y, width, height } = display.bounds;
    const anchor = screen.dipToScreenPoint({ x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) });
    const configured = await helper(['configure', hwnd(overlay), String(process.pid), String(anchor.x), String(anchor.y)]);
    const placed = await helper(['inspect', hwnd(overlay), String(process.pid)]);
    await overlay.loadURL('data:text/html,<html><body style="margin:0;background:#000"></body></html>');
    const shown = once(overlay, 'show');
    overlay.show();
    overlay.focus();
    overlay.moveTop();
    await shown;
    const visible = await helper(['inspect', hwnd(overlay), String(process.pid)]);
    const edge = Math.max(configured.monitor.width, configured.monitor.height);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: edge, height: edge } });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    console.log(JSON.stringify({
      scaleFactor: display.scaleFactor,
      contentBounds: overlay.getContentBounds(),
      monitor: configured.monitor,
      placed: placed.window,
      visible: visible.window,
      thumbnail: source === undefined ? null : source.thumbnail.getSize(),
    }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
