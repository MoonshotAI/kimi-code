const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const events = require('node:events');
const path = require('node:path');
const { promisify } = require('node:util');
const { app, BrowserWindow } = require('electron');

const run = promisify(execFile);
const executable = path.join(__dirname, '../../../native/screenshot-window-list/dist/screenshot-window-list.exe');
const id = (window) => window.getNativeWindowHandle().readBigUInt64LE().toString();
const timeout = setTimeout(() => {
  console.error('Windows screenshot native smoke test timed out');
  app.exit(1);
}, 20_000);

app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32');
  const options = { width: 240, height: 180, x: 50, y: 50, show: false };
  const ordinary = new BrowserWindow(options);
  const dialog = new BrowserWindow({ ...options, parent: ordinary, modal: true });
  const panel = new BrowserWindow({ ...options, skipTaskbar: true });
  const overlay = new BrowserWindow({ ...options, frame: false });
  const hidden = new BrowserWindow(options);
  const minimized = new BrowserWindow(options);
  ordinary.show();
  dialog.show();
  panel.show();
  overlay.show();
  minimized.show();
  const didMinimize = events.once(minimized, 'minimize');
  minimized.minimize();
  await didMinimize;
  const { stdout } = await run(executable, [id(overlay)], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.units, 'pixels');
  const ids = result.windows.map((window) => window.id);
  assert.ok(ids.includes(id(ordinary)), 'ordinary windows in the calling app must be selectable');
  assert.ok(ids.includes(id(dialog)), 'owned dialogs must be selectable');
  assert.ok(ids.includes(id(panel)), 'interactive floating windows must be selectable');
  assert.ok(!ids.includes(id(overlay)), 'the supplied overlay handle must be excluded');
  assert.ok(!ids.includes(id(hidden)), 'hidden windows must be excluded');
  assert.ok(!ids.includes(id(minimized)), 'minimized windows must be excluded');
  for (const window of result.windows) {
    assert.match(window.id, /^\d+$/);
    assert.ok([window.x, window.y, window.width, window.height].every(Number.isFinite));
    assert.ok(window.width >= 8 && window.height >= 8);
  }
  console.log('Windows screenshot native smoke test passed');
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
