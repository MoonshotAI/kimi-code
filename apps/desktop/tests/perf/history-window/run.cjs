const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile, writeFile } = require('node:fs/promises');
const pathModule = require('node:path');
const os = require('node:os');
app.setPath('userData', pathModule.resolve(process.env.PERF_PROFILE_DIR || '.tmp/markdown-perf/electron-profile'));
const [output, ...variants] = process.argv.slice(2);
const results = [];
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let directory = '';
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (process.env.PERF_IMAGES && pathname === '/history-image-retry.gif') {
        response.setHeader('Content-Type', 'image/gif');
        response.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        return;
      }
      const path = pathModule.resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!path.startsWith(directory + '/')) throw new Error('Invalid path');
      const body = await readFile(path);
      response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm' })[pathModule.extname(path)] || 'application/octet-stream');
      response.end(body);
    } catch { response.writeHead(404).end(); }
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const variant of variants) {
      directory = pathModule.resolve(variant);
      for (const name of [process.env.PERF_MOBILE ? 'mobile' : 'history']) {
        const win = new BrowserWindow({ width: process.env.PERF_MOBILE ? 390 : 1280, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
        if (!process.env.PERF_HEADLESS) win.showInactive();
        const errors = [];
        win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message); } });
        await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
        await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Performance.enable');
        if (process.env.PERF_NAVIGATION || process.env.PERF_BEHAVIOR || process.env.PERF_SCROLL_KEYS || process.env.PERF_FOLLOW || process.env.PERF_MOBILE) await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
        const before = await win.webContents.debugger.sendCommand('Performance.getMetrics');
        if (process.env.PERF_PROFILE) {
          await win.webContents.debugger.sendCommand('Profiler.enable');
          await win.webContents.debugger.sendCommand('Profiler.start');
        }
        let result;
        try { result = await win.webContents.executeJavaScript(`window.replay(${JSON.stringify(name)}, ${Number(process.env.HISTORY_COUNT) || 240})`); }
        catch (error) {
          console.log(await win.webContents.executeJavaScript('JSON.stringify({text:document.body.innerText.slice(-2000),panes:Array.from(document.querySelectorAll(".panes")).map(el=>({h:el.clientHeight,scroll:el.scrollTop,total:el.scrollHeight})),tail:document.querySelector("[data-turn-id=turn-239]")?.outerHTML.slice(0,1200)})'));
          await writeFile(output.replace('.json', '-failed.png'), (await win.webContents.capturePage()).toPNG());
          throw error;
        }
        const after = await win.webContents.debugger.sendCommand('Performance.getMetrics');
        if (process.env.PERF_PROFILE) {
          const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop');
          await writeFile(output.replace('.json', '-' + variants.indexOf(variant) + '-' + name + '.cpuprofile'), JSON.stringify(profile));
        }
        const metrics = Object.fromEntries(after.metrics.map(({ name, value }) => [name, value]));
        const initial = Object.fromEntries(before.metrics.map(({ name, value }) => [name, value]));
        Object.assign(result, { variant, errors, viewport: await win.webContents.executeJavaScript('[innerWidth, innerHeight]'), taskMs: (metrics.TaskDuration - initial.TaskDuration) * 1000, scriptMs: (metrics.ScriptDuration - initial.ScriptDuration) * 1000, layoutMs: (metrics.LayoutDuration - initial.LayoutDuration) * 1000, heapBefore: initial.JSHeapUsedSize, heapAfter: metrics.JSHeapUsedSize });
        if (process.env.PERF_BOUNDARY) result.boundary = await win.webContents.executeJavaScript('window.verifyBoundary()');
        if (process.env.PERF_GEOMETRY) result.geometry = await win.webContents.executeJavaScript('window.verifyGeometry()');
        if (process.env.PERF_LAYOUT) result.layout = await win.webContents.executeJavaScript('window.verifyLayout()');
        if (process.env.PERF_MOBILE) result.mobile = await win.webContents.executeJavaScript('window.verifyMobileHistory()');
        if (process.env.PERF_IMAGES) result.images = await win.webContents.executeJavaScript('window.verifyImages()');
        if (process.env.PERF_SPACING) result.spacing = await win.webContents.executeJavaScript('window.verifySpacing()');
        if (process.env.PERF_STATE) result.state = await win.webContents.executeJavaScript('window.verifyHistoryState()');
        if (process.env.PERF_FONT) result.font = await win.webContents.executeJavaScript('window.verifyFontScale()');
        if (process.env.PERF_SCROLL_KEYS) {
          result.scrollKeys = [];
          for (const [key, code, windowsVirtualKeyCode, direction, repeats] of [
            ['PageDown', 'PageDown', 34, 1, 1], ['PageUp', 'PageUp', 33, -1, 1],
            ['ArrowDown', 'ArrowDown', 40, 1, 4], ['ArrowUp', 'ArrowUp', 38, -1, 4],
            [' ', 'Space', 32, 1, 1], ['Home', 'Home', 36, -1, 1], ['End', 'End', 35, 1, 1],
          ]) {
            await win.webContents.executeJavaScript('window.prepareScrollKey()');
            for (let i = 0; i < repeats; i++) {
              await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(key === ' ' ? { text: ' ' } : {}) });
              await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
              await new Promise(resolve => setTimeout(resolve, 40));
            }
            result.scrollKeys.push({ key, ...await win.webContents.executeJavaScript(`window.finishScrollKey(${direction})`) });
          }
        }
        if (process.env.PERF_FOLLOW) {
          const input = (method, params) => win.webContents.debugger.sendCommand(method, params);
          const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
          const page = code => win.webContents.executeJavaScript(code);
          const wheel = async (point, deltaY) => {
            await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
            await input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY });
            await pause(500);
          };
          const state = () => page('window.followState()');
          const reset = () => page('window.resetFollow()');
          const points = await page('window.prepareFollow()');
          const steps = {};
          await wheel(points.text, -40);
          steps.nudge = await state();
          await wheel(points.text, -1200);
          steps.far = await state();
          await wheel(points.text, 6000);
          steps.back = await state();
          await reset();
          await wheel(points.text, -1);
          await wheel(points.text, 200);
          steps.pixel = await state();
          await reset();
          await wheel(points.output, -150);
          steps.output = await state();
          await reset();
          await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
          await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
          await pause(500);
          steps.endKey = await state();
          await reset();
          await wheel(points.text, -300);
          steps.above = await page('window.growAboveFollow()');
          await reset();
          await wheel(points.text, -(Math.round(points.viewport / 2) - 40));
          steps.detached = await state();
          steps.grown = await page('window.growFollow()');
          await reset();
          await page('window.startFollowStream()');
          await wheel(points.text, -60);
          steps.streamDetached = await state();
          steps.streamed = await page('window.streamFollow()');
          await reset();
          steps.steady = await page('window.streamSteadyFollow()');
          await reset();
          const drag = await page('window.startGrowthTicker()');
          await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.start.x, y: drag.start.y });
          await input('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.start.x, y: drag.start.y, button: 'left', buttons: 1, clickCount: 1 });
          for (let i = 1; i <= 6; i++) {
            await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.start.x, y: Math.round(drag.start.y + (drag.above.y - drag.start.y) * i / 6), button: 'left', buttons: 1 });
            await pause(30);
          }
          await pause(700);
          steps.select = await state();
          await input('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.above.x, y: drag.above.y, button: 'left', buttons: 0, clickCount: 1 });
          await page('window.stopGrowthTicker()');
          steps.settle = await page('window.verifySettle()');
          console.log(JSON.stringify({ followSteps: steps }));
          result.follow = await page(`window.finishFollow(${JSON.stringify(steps)})`);
        }
        if (process.env.PERF_TOOLS) {
          result.tools = await win.webContents.executeJavaScript('window.verifyTools()');
          if (process.env.PERF_NAVIGATION) result.toolNavigation = await win.webContents.executeJavaScript('window.verifyToolNavigation()');
        }
        if (process.env.PERF_NAVIGATION && !process.env.PERF_TOOLS) {
          result.navigationSetup = await win.webContents.executeJavaScript('window.prepareHistoryNavigation()');
          const tree = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
          for (const label of ['Previous item', 'Next item']) {
            if (!tree.nodes.some(node => !node.ignored && node.role?.value === 'button' && node.name?.value === label)) throw new Error(`Missing accessible navigation: ${label}`);
          }
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          try {
            result.navigation = await win.webContents.executeJavaScript('window.finishHistoryNavigation()');
            await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
            await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
            result.navigationTab = await win.webContents.executeJavaScript('window.verifyHistoryTab()');
            await writeFile(output.replace('.json', '-focus.png'), (await win.webContents.capturePage()).toPNG());
            await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
            await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            result.navigationEnter = await win.webContents.executeJavaScript('window.verifyHistoryEnter()');
          }
          catch (error) {
            console.log(await win.webContents.executeJavaScript('JSON.stringify({focus:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,800),mounted:Array.from(document.querySelectorAll(".panes [data-turn-id]")).map(el=>el.dataset.turnId)})'));
            throw error;
          }
        }
        if (process.env.PERF_BEHAVIOR) {
          try { result.behavior = await win.webContents.executeJavaScript('window.verify()'); }
          catch (error) {
            console.log(await win.webContents.executeJavaScript(`JSON.stringify({collapsed:document.getSelection()?.isCollapsed,anchor:document.getSelection()?.anchorNode?.parentElement?.outerHTML.slice(0,400),focus:document.getSelection()?.focusNode?.parentElement?.outerHTML.slice(0,400)})`));
            console.log(await win.webContents.executeJavaScript('JSON.stringify({active:document.activeElement?.outerHTML.slice(0,400),selected:document.getSelection()?.toString().slice(0,100),top101:document.querySelector("[data-turn-id=turn-101]")?.getBoundingClientRect().top,top201:document.querySelector("[data-turn-id=turn-201]")?.getBoundingClientRect().top,scroll:document.querySelector(".panes")?.scrollTop})'));
            throw error;
          }
          await writeFile(output.replace('.json', '-' + variants.indexOf(variant) + '-light.png'), (await win.webContents.capturePage()).toPNG());
        }
        if (name === 'long') result.fullCode = await win.webContents.executeJavaScript('window.verifyLongContent?.() ?? null');
        results.push(result);
        console.log(JSON.stringify(result));
        win.destroy();
        const behaviorChecks = ['fold', 'wrap', 'numbers', 'search', 'toc'];
        if (result.fullCode === false || (result.missing?.length ?? 0) || errors.length || result.spacing?.some(item => item.differences.length) || (result.behavior && behaviorChecks.some(key => !result.behavior[key]))) throw new Error('Replay correctness check failed');
      }
    }
  } finally {
    await writeFile(output, JSON.stringify({ environment: { versions: process.versions, os: os.release(), cpu: os.cpus()[0].model, memory: os.totalmem(), windowBounds: [process.env.PERF_MOBILE ? 390 : 1280, 900], throttle: 1, gc: false }, results }, null, 2));
    server.close();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
