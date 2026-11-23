const Module = require('node:module');

const outputFile = process.env.KIMI_E2E_OUTPUT_FILE;
if (outputFile) {
  const { appendFileSync } = process.getBuiltinModule('node:fs');
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      appendFileSync(outputFile, chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
      return write(chunk, ...rest);
    };
  }
  process.stderr.write('[kimi-e2e] recording the main process output\n');
}

const electron = require('electron');

const { app, dialog, shell, BaseWindow, BrowserWindow } = electron;
const quiet = process.env.KIMI_DESKTOP_E2E === 'quiet';

const calls = [];
const focusRequests = [];
const scriptedAnswers = [];
const answeredCalls = [];
globalThis.__kimiE2eNativeCalls = calls;
globalThis.__kimiE2eFocusRequests = focusRequests;
globalThis.__kimiE2eScriptedAnswers = scriptedAnswers;
globalThis.__kimiE2eAnsweredCalls = answeredCalls;

if (quiet && process.platform === 'darwin') app.setActivationPolicy('prohibited');

if (process.env.KIMI_E2E_DOWNLOADS_DIR) app.setPath('downloads', process.env.KIMI_E2E_DOWNLOADS_DIR);

function describe(args) {
  const options = args.find(arg => arg !== null && typeof arg === 'object' && !('webContents' in arg));
  if (options === undefined) return args.filter(arg => typeof arg === 'string').join(' | ');
  return [options.title, options.message, options.detail, options.defaultPath].filter(Boolean).join(' | ');
}

function block(target, name, answer) {
  target[name] = (...args) => {
    const index = scriptedAnswers.findIndex(entry => entry.api === name);
    if (index !== -1) {
      const [scripted] = scriptedAnswers.splice(index, 1);
      answeredCalls.push({ api: name, detail: describe(args) });
      process.stderr.write(`[kimi-e2e] answered native ${name} from the test script: ${describe(args)}\n`);
      return name.endsWith('Sync') ? scripted.answer : Promise.resolve(scripted.answer);
    }
    const call = { api: name, detail: describe(args) };
    calls.push(call);
    process.stderr.write(`[kimi-e2e] blocked native ${name}: ${call.detail}\n`);
    return answer(args);
  };
}

const cancelId = args => args.find(arg => arg !== null && typeof arg === 'object' && 'buttons' in arg)?.cancelId ?? 0;
block(dialog, 'showMessageBox', args => Promise.resolve({ response: cancelId(args), checkboxChecked: false }));
block(dialog, 'showMessageBoxSync', cancelId);
block(dialog, 'showOpenDialog', () => Promise.resolve({ canceled: true, filePaths: [] }));
block(dialog, 'showOpenDialogSync', () => undefined);
block(dialog, 'showSaveDialog', () => Promise.resolve({ canceled: true, filePath: '' }));
block(dialog, 'showSaveDialogSync', () => '');
block(dialog, 'showErrorBox', () => undefined);
block(dialog, 'showCertificateTrustDialog', () => Promise.resolve());
block(shell, 'openExternal', () => Promise.resolve());
block(shell, 'openPath', () => Promise.resolve(''));
block(shell, 'showItemInFolder', () => undefined);

const PRINT_SCRIPT = /^\s*window\.print\(\)\s*;?\s*$/;

function nativePrint(detail) {
  const index = scriptedAnswers.findIndex(entry => entry.api === 'print');
  if (index !== -1) {
    scriptedAnswers.splice(index, 1);
    answeredCalls.push({ api: 'print', detail });
    process.stderr.write(`[kimi-e2e] answered native print from the test script: ${detail}\n`);
    return;
  }
  calls.push({ api: 'print', detail });
  process.stderr.write(`[kimi-e2e] blocked native print: ${detail}\n`);
}

app.once('web-contents-created', (_event, contents) => {
  const proto = Object.getPrototypeOf(contents);
  const executeInIsolatedWorld = proto.executeJavaScriptInIsolatedWorld;
  proto.executeJavaScriptInIsolatedWorld = function (worldId, scripts, ...rest) {
    if (Array.isArray(scripts) && scripts.some(script => PRINT_SCRIPT.test(script?.code ?? ''))) {
      nativePrint(`window.print() in isolated world ${worldId} of ${this.getURL()}`);
      return Promise.resolve(undefined);
    }
    return executeInIsolatedWorld.call(this, worldId, scripts, ...rest);
  };
  proto.print = function (_options, callback) {
    nativePrint(`webContents.print() of ${this.getURL()}`);
    if (typeof callback === 'function') callback(false, 'cancelled');
  };
});

function ownerOf(target, name) {
  for (let proto = target; proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) return proto;
  }
  return null;
}

const neutralized = new WeakSet();

function neutralize(target, label, name, replacement = () => undefined) {
  const owner = ownerOf(target, name);
  if (owner === null || neutralized.has(owner[name])) return;
  const quietMethod = function (...args) {
    focusRequests.push(`${label}.${name}`);
    return replacement.call(this, ...args);
  };
  neutralized.add(quietMethod);
  owner[name] = quietMethod;
}

function quietWindowOptions(options, withWebPreferences) {
  const quietOptions = { ...options, show: false, focusable: false, skipTaskbar: true, paintWhenInitiallyHidden: true };
  if (withWebPreferences) quietOptions.webPreferences = { ...options?.webPreferences, backgroundThrottling: false };
  return quietOptions;
}

function hideWindow(win) {
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.setSkipTaskbar(true);
  win.setPosition(-32000, -32000);
}

function installQuietMode() {
  const disabledFeatures = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch('disable-features', [disabledFeatures, 'CalculateNativeWinOcclusion'].filter(Boolean).join(','));
  class QuietBaseWindow extends BaseWindow {
    constructor(options) {
      super(quietWindowOptions(options, false));
      hideWindow(this);
    }
  }
  class QuietBrowserWindow extends BrowserWindow {
    constructor(options) {
      super(quietWindowOptions(options, true));
    }
  }
  const overrides = { BaseWindow: QuietBaseWindow, BrowserWindow: QuietBrowserWindow };
  const quietModules = new WeakMap();
  const quietModule = (loaded) => {
    let wrapped = quietModules.get(loaded);
    if (wrapped === undefined) {
      wrapped = {};
      for (const key of Object.keys(loaded)) {
        Object.defineProperty(wrapped, key, { enumerable: true, get: () => overrides[key] ?? loaded[key] });
      }
      quietModules.set(loaded, wrapped);
    }
    return wrapped;
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const loaded = load.call(this, request, ...rest);
    return request === 'electron' || request === 'electron/main' ? quietModule(loaded) : loaded;
  };

  for (const [label, target] of [['BrowserWindow', BrowserWindow.prototype], ['BaseWindow', BaseWindow.prototype]]) {
    neutralize(target, label, 'focus');
    neutralize(target, label, 'moveTop');
    neutralize(target, label, 'setAlwaysOnTop');
    neutralize(target, label, 'flashFrame');
    neutralize(target, label, 'show', function () { this.showInactive(); });
    const owner = ownerOf(target, 'showInactive');
    if (owner !== null && !neutralized.has(owner.showInactive)) {
      const showInactive = owner.showInactive;
      const quietShowInactive = function (...args) {
        hideWindow(this);
        const result = showInactive.call(this, ...args);
        this.setPosition(-32000, -32000);
        return result;
      };
      neutralized.add(quietShowInactive);
      owner.showInactive = quietShowInactive;
    }
  }
  neutralize(app, 'app', 'focus');
  neutralize(app, 'app', 'show');
  if (app.dock) {
    neutralize(app.dock, 'app.dock', 'show', () => Promise.resolve());
    neutralize(app.dock, 'app.dock', 'bounce', () => -1);
  }

  app.on('browser-window-created', (_event, win) => {
    win.setFocusable(false);
    hideWindow(win);
  });
  app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false));
  app.once('web-contents-created', (_event, contents) => {
    const proto = Object.getPrototypeOf(contents);
    neutralize(proto, 'webContents', 'focus');
    const setWindowOpenHandler = proto.setWindowOpenHandler;
    proto.setWindowOpenHandler = function (handler) {
      return setWindowOpenHandler.call(this, (details) => {
        const result = handler(details);
        if (result?.action !== 'allow') return result;
        return { ...result, overrideBrowserWindowOptions: quietWindowOptions(result.overrideBrowserWindowOptions, true) };
      });
    };
  });
}

if (quiet) installQuietMode();
