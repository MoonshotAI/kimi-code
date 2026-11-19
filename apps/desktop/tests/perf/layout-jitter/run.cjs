const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile, writeFile } = require('node:fs/promises');
const pathModule = require('node:path');
app.setPath('userData', pathModule.resolve('.tmp/layout-jitter/electron-profile'));
const [output, directoryArg, ...counts] = process.argv.slice(2);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = pathModule.resolve(directoryArg);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const path = pathModule.resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!path.startsWith(directory + '/')) throw new Error('Invalid path');
      const body = await readFile(path);
      response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm' })[pathModule.extname(path)] || 'application/octet-stream');
      response.end(body);
    } catch { response.writeHead(404).end(); }
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const results = [];
  try {
    for (const count of counts.length ? counts.map(Number) : [16, 60]) {
      const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
      win.showInactive();
      const errors = [];
      win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
      await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      const run = code => win.webContents.executeJavaScript(code);
      const result = { count, setup: await run(`window.setup(${count})`) };
      for (const scenario of (process.env.JITTER_SCENARIOS ?? 'resizeMiddle,resizeBottom,tableCrossing,tableWide,rowShrinkMiddle,scrollUpHistory,loadOlderWhileScrolling,loadLastPageWhileScrolling,randomEvents,streamBottom,bashBottom,bashMiddle').split(',')) {
        result[scenario] = await run(`window.${scenario}()`);
      }
      result.loopErrors = await run('window.loopErrors()');
      result.consoleErrors = errors;
      results.push(result);
      console.log(JSON.stringify(result, null, 2));
      win.destroy();
    }
  } finally {
    await writeFile(output, JSON.stringify(results, null, 2));
    server.close();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
