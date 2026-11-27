const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { app, BrowserWindow, protocol, nativeImage, screen } = require('electron');
const output = require(path.join(process.argv[2], 'screenshot-output.cjs'));
const protocols = require(path.join(process.argv[2], 'protocol.cjs'));

app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'pin-window-')));
app.on('window-all-closed', () => {});
protocols.registerAppSchemes();
const timeout = setTimeout(() => { console.error('pin check timed out'); app.exit(1); }, 45_000);
async function closeWindow(win) {
  await new Promise(resolve => { win.once('closed', resolve); win.close(); });
}
app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32');
  protocols.registerRendererProtocol(() => path.join(process.argv[3], 'desktop-dist'));
  protocol.handle('shot', request => {
    const token = new URL(request.url).pathname.slice(1, -4);
    const png = output.pinnedScreenshotBuffer(token);
    return new Response(png, { status: png ? 200 : 404, headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' } });
  });
  output.initPinnedScreenshotIpc();
  const bitmap = Buffer.alloc(800 * 400 * 4);
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = 100; bitmap[i + 1] = 170; bitmap[i + 2] = 40; bitmap[i + 3] = 255;
  }
  const png = nativeImage.createFromBitmap(bitmap, { width: 800, height: 400 }).toPNG();
  const durations = [];
  const displays = screen.getAllDisplays();
  let previous;
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    const win = await output.createPinnedScreenshot(png, 800, 400, 'zh');
    durations.push(Math.round(performance.now() - started));
    assert.equal(win.isVisible(), true);
    assert.equal(win.isAlwaysOnTop(), true);
    assert.equal(win.isFocused(), false);
    const area = displays[i % displays.length].workArea;
    const initial = win.getBounds();
    await win.webContents.executeJavaScript(`window.pinBridge.move(${area.x + 100 - initial.x}, ${area.y + 100 - initial.y})`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const beforeDrag = win.getBounds();
    await win.webContents.executeJavaScript('for (let i = 0; i < 500; i++) { window.pinBridge.move(1.25, -0.75); window.pinBridge.move(-1.25, 0.75); }');
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterDrag = win.getBounds();
    assert.deepEqual(afterDrag, beforeDrag);
    win.setPosition(afterDrag.x + 60, afterDrag.y + 40);
    await new Promise(resolve => setTimeout(resolve, 50));
    const relocated = win.getPosition();
    await win.webContents.executeJavaScript('window.pinBridge.resize(0.1)');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(win.getPosition(), relocated);
    await win.webContents.executeJavaScript('window.pinBridge.move(-60, -40)');
    await new Promise(resolve => setTimeout(resolve, 50));
    await win.webContents.executeJavaScript(`window.pinBridge.move(${-afterDrag.x - 0.25}, ${-afterDrag.y - 0.25})`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const atOrigin = win.getBounds();
    assert.ok(Math.abs(atOrigin.x) <= 1 && Math.abs(atOrigin.y) <= 1);
    await win.webContents.executeJavaScript(`window.pinBridge.move(${beforeDrag.x - atOrigin.x}, ${beforeDrag.y - atOrigin.y})`);
    await new Promise(resolve => setTimeout(resolve, 50));
    const frame = await win.webContents.capturePage();
    const bytes = frame.toBitmap();
    const size = frame.getSize();
    const pixel = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
    assert.deepEqual([...bytes.subarray(pixel, pixel + 4)], [100, 170, 40, 255]);
    if (previous) {
      assert.equal(previous.isVisible(), true);
      await closeWindow(previous);
      assert.equal(win.isDestroyed(), false);
    }
    previous = win;
  }
  const src = await previous.webContents.executeJavaScript('document.querySelector("img").src');
  const token = new URL(src).pathname.slice(1, -4);
  assert.deepEqual(output.pinnedScreenshotBuffer(token), png);
  await closeWindow(previous);
  assert.equal(output.pinnedScreenshotBuffer(token), undefined);
  await assert.rejects(output.createPinnedScreenshot(Buffer.from('invalid image'), 800, 400, 'zh'), /pin-image-load-failed/);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  console.log(JSON.stringify({ displays: displays.map(d => ({ scale: d.scaleFactor, bounds: d.bounds })), pinReadyMs: durations, checks: 'visible, topmost, nonfocused, stable size after repeated fractional moves, native relocation followed by zoom, negative zero at origin, decoded pixels, independent close, invalid image cleanup' }));
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
