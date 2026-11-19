const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const overlayAddon = require(process.argv[2]);
const probe = require(process.argv[3]);

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'screenshot-macos-overlay-')));
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
app.on('window-all-closed', () => {});

const timeout = setTimeout(() => {
  console.error('macOS screenshot overlay IME level test timed out');
  app.exit(1);
}, 20_000);

app.whenReady().then(async () => {
  assert.equal(process.platform, 'darwin');
  const rwhvRespondsBefore = probe.rwhvResponds();

  const overlay = new BrowserWindow({
    width: 320,
    height: 200,
    frame: false,
    type: 'panel',
    transparent: true,
    show: false,
    backgroundColor: '#00000000',
  });
  const normal = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  await Promise.all([
    overlay.loadURL('data:text/html,<textarea id="shot-comment"></textarea>'),
    normal.loadURL('data:text/html,<textarea id="main-input"></textarea>'),
  ]);

  const before = probe.attachSyntheticClients(overlay.getNativeWindowHandle());
  const firstId = overlayAddon.configure(overlay.getNativeWindowHandle());
  const secondId = overlayAddon.configure(overlay.getNativeWindowHandle());
  assert.equal(firstId, secondId);
  assert.match(firstId, /^\d+$/);

  const after = probe.inspectWindows(overlay.getNativeWindowHandle(), normal.getNativeWindowHandle());
  const rwhvRespondsAfter = probe.rwhvResponds();

  overlay.destroy();
  normal.destroy();
  console.log(JSON.stringify({ rwhvRespondsBefore, rwhvRespondsAfter, before, after }));
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
