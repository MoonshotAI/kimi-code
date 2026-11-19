const { app, BrowserWindow, ipcMain, screen } = require('electron');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '../..');
const transparent = true;
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'screenshot-presentation-')));
app.on('window-all-closed', () => {});
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
void app.whenReady().then(async () => {
  app.dock?.hide();
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      res.setHeader('content-type', mime[path.extname(pathname)] || 'application/octet-stream');
      res.end(await readFile(path.join(root, 'desktop-dist', pathname)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { width, height } = screen.getPrimaryDisplay().bounds;
    const win = new BrowserWindow({ width, height, enableLargerThanScreen: true, frame: false, type: 'panel', hasShadow: false,
      show: false, transparent, backgroundColor: transparent ? '#00000000' : '#000000',
      webPreferences: { preload: path.join(root, 'out/shotPreload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    require(path.join(root, 'native/screenshot-window-list/dist/screenshot-overlay.node')).configure(win.getNativeWindowHandle());
    const loaded = new Promise((resolve) => ipcMain.once('kimi:shot-loaded', resolve));
    await win.loadURL(`http://127.0.0.1:${server.address().port}/screenshot/index.html?display=1`);
    await loaded;
    async function sample(phase) {
      const started = performance.now();
      const image = await win.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
      const captureMs = Math.round(performance.now() - started);
      const bytes = image.toBitmap();
      let opaque = 0, white = 0, black = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        if (bytes[i + 3] === 255) opaque++;
        if (bytes[i] > 250 && bytes[i+1] > 250 && bytes[i+2] > 250) white++;
        if (bytes[i] < 5 && bytes[i+1] < 5 && bytes[i+2] < 5) black++;
      }
      const pixels = bytes.length / 4;
      assert.equal(win.isVisible(), false);
      console.log(JSON.stringify({ phase, transparent, pixels, opaque: opaque/pixels, white: white/pixels, black: black/pixels, visible: win.isVisible(), captureMs }));
      return { opaque, pixels };
    }
    const empty = await sample('warmup');
    for (let cycle = 0; cycle < 3; cycle++) {
      const ready = new Promise((resolve) => ipcMain.once('kimi:shot-ready', resolve));
      win.webContents.send('kimi:shot-set-context', {
        captureId: String(cycle), displayId: '1', locale: cycle === 2 ? 'zh' : 'en', pointer: { x: 300, y: cycle === 1 ? 50 : 200 },
        windows: [{ id: 'window', x: 80, y: cycle === 1 ? 20 : 80, width: 480, height: cycle === 1 ? 80 : 200 }],
        frameUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><path fill="#45a986" d="M0 0h640v400H0z"/></svg>'),
        sourceSize: { width: 640, height: 400 }, displaySize: { width: 640, height: 400 },
      });
      await ready;
      let image;
      const deadline = performance.now() + 1000;
      do {
        image = await sample('ready-' + cycle);
        if (image.opaque === image.pixels) break;
        await new Promise(r => setTimeout(r, 16));
      } while (performance.now() < deadline);
      assert.equal(image.opaque, image.pixels);
      const commentUi = await win.webContents.executeJavaScript(`(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const input = document.querySelector('#shot-comment');
        const toolbar = document.querySelector('.shot__toolbar');
        const measure = () => ({ height: input.getBoundingClientRect().height, scroll: input.scrollHeight, client: input.clientHeight, width: toolbar.getBoundingClientRect().width, top: toolbar.getBoundingClientRect().top, bottom: toolbar.getBoundingClientRect().bottom });
        const initial = measure();
        async function fill(value) {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
          return measure();
        }
        const two = await fill('First line\\nSecond line');
        const four = await fill('One\\nTwo\\nThree\\nFour');
        const overflow = await fill('One\\nTwo\\nThree\\nFour\\nFive\\nSix');
        const wrapped = await fill('Long comment '.repeat(100));
        const cleared = await fill('');
        return {
          inputType: input?.tagName,
          visible: input?.getBoundingClientRect().height > 0,
          focused: document.activeElement === input,
          enter: document.querySelector('.shot__conversation-actions button')?.textContent.includes('↵'),
          initial, two, four, overflow, wrapped, cleared,
        };
      })()`);
      const { initial, two, four, overflow, wrapped, cleared, ...ui } = commentUi;
      assert.deepEqual(ui, { inputType: 'TEXTAREA', visible: true, focused: false, enter: true });
      assert.ok(two.height > initial.height);
      assert.ok(four.height > two.height);
      assert.equal(overflow.height, four.height);
      assert.equal(wrapped.height, four.height);
      assert.ok(overflow.scroll > overflow.client);
      assert.equal(cleared.height, initial.height);
      for (const state of [two, four, overflow, wrapped, cleared]) {
        assert.equal(state.width, initial.width);
        assert.ok(state.top >= 10 && state.bottom <= 390);
        if (cycle === 1) assert.equal(state.top, initial.top);
        else assert.equal(state.bottom, initial.bottom);
      }
      console.log(JSON.stringify({ phase: 'comment-' + cycle, ...commentUi }));
      const tooltip = await win.webContents.executeJavaScript(`(async () => {
        const button = document.querySelector('.shot__conversation-actions button');
        const bounds = button.getBoundingClientRect();
        for (const offset of [1, 2]) button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bounds.x + offset, clientY: bounds.y + 1 }));
        await new Promise(r => setTimeout(r, 200));
        const bubble = document.querySelector('[role="tooltip"]');
        if (!bubble) throw new Error('Add tooltip did not open');
        const range = document.createRange();
        range.selectNodeContents(bubble);
        return { lines: range.getClientRects().length, width: bubble.getBoundingClientRect().width, text: bubble.textContent.trim() };
      })()`);
      assert.equal(tooltip.lines, 1);
      assert.ok(tooltip.width <= 280);
      assert.ok(tooltip.text.includes('Shift+Enter'));
      console.log(JSON.stringify({ phase: 'tooltip-' + cycle, ...tooltip }));
      win.webContents.send('kimi:shot-set-context', null);
      await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const clearedFrame = await sample('cleared-' + cycle);
      if (transparent) assert.equal(clearedFrame.opaque, 0);
    }
    if (transparent) assert.equal(empty.opaque, 0);
    win.destroy();
    server.close(); app.exit(0);
  } catch (error) { console.error(error); server.close(); app.exit(1); }
});
