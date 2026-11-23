import { createRequire } from 'node:module';
import fs from 'node:fs';

import { PNG } from 'pngjs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  version: '0.0.25-preview.123.1.g12345678',
  setName: vi.fn(),
  initMainLogging: vi.fn(),
  logLaunchBanner: vi.fn(),
  startCrashReporter: vi.fn(),
  importSettings: vi.fn(),
  main: vi.fn(),
  registerSchemes: vi.fn(),
  appendSwitch: vi.fn(),
  updater: { on: vi.fn(), setFeedURL: vi.fn(), checkForUpdates: vi.fn() },
}));

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: mocks.registerSchemes },
  app: {
    getVersion: () => mocks.version,
    setName: mocks.setName,
    getPath: () => '/preview-user-data',
    isPackaged: true,
    commandLine: { appendSwitch: mocks.appendSwitch },
  },
}));
vi.mock('../../../src/main/diagnostics/log', () => ({
  initMainLogging: mocks.initMainLogging,
  logLaunchBanner: mocks.logLaunchBanner,
  log: { warn: vi.fn() },
}));
vi.mock('../../../src/main/diagnostics/crash-reporter', () => ({ startCrashReporter: mocks.startCrashReporter }));
vi.mock('../../../src/main/release/stable-settings-import', () => ({ consumePendingStableImport: mocks.importSettings }));
vi.mock('../../../src/main/system/shell-env', () => ({ startShellEnvProbe: vi.fn() }));
vi.mock('../../../src/main/app/lifecycle', () => ({ main: mocks.main }));
vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }));
vi.mock('../../../src/main/window/main-window', () => ({ sendToRenderer: vi.fn(), markQuitting: vi.fn() }));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: vi.fn(), trySendDesktopEvent: vi.fn() }));
vi.mock('../../../src/main/app/ui-state', () => ({ isUpdateAutoDownloadEnabled: () => true }));

const require = createRequire(import.meta.url);
const configPath = require.resolve('../../../electron-builder.config.cjs');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
  delete require.cache[configPath];
});

describe('Preview distribution', () => {
  it('selects its own user-data name before logging and does not import stable settings', async () => {
    await import('../../../src/main/app/index');
    await vi.waitFor(() => expect(mocks.main).toHaveBeenCalledOnce());
    expect(mocks.registerSchemes).toHaveBeenCalledExactlyOnceWith([
      { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
      { scheme: 'shot', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
    ]);
    expect(mocks.registerSchemes.mock.invocationCallOrder[0]).toBeLessThan(mocks.main.mock.invocationCallOrder[0]!);
    expect(mocks.setName).toHaveBeenCalledWith('Kimi Code Preview');
    expect(mocks.setName.mock.invocationCallOrder[0]).toBeLessThan(mocks.initMainLogging.mock.invocationCallOrder[0]!);
    expect(mocks.logLaunchBanner).toHaveBeenCalledOnce();
    expect(mocks.setName.mock.invocationCallOrder[0]).toBeLessThan(mocks.startCrashReporter.mock.invocationCallOrder[0]!);
    expect(mocks.startCrashReporter.mock.invocationCallOrder[0]).toBeLessThan(mocks.main.mock.invocationCallOrder[0]!);
    expect(mocks.importSettings).not.toHaveBeenCalled();
  });

  it('opts in to JavaScript call stacks from unresponsive pages as a single enable-features switch', async () => {
    await import('../../../src/main/app/index');
    const calls = mocks.appendSwitch.mock.calls.filter(([name]) => name === 'enable-features');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.split(',')).toContain('DocumentPolicyIncludeJSCallStacksInCrashReports');
  });

  it('never initializes update listeners or an update feed, even with auto-download enabled', async () => {
    const updater = await import('../../../src/main/release/updater');
    updater.initAutoUpdater({
      confirmRestart: vi.fn(async () => ({ proceed: true, continueSessionIds: [] })),
      prepareSessionContinue: vi.fn(),
    });
    expect(await updater.requestUpdateCheck()).toEqual({ outcome: 'unsupported' });
    updater.requestUpdateDownload();
    await updater.requestUpdateInstall();
    expect(mocks.updater.on).not.toHaveBeenCalled();
    expect(mocks.updater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it.each([
    ['stable', false, false, 'com.kimi.code.desktop', 'Kimi Code'],
    ['canary', true, false, 'com.kimi.code.desktop.canary', 'Kimi Code Canary'],
    ['preview', false, true, 'com.kimi.code.desktop.preview', 'Kimi Code Preview'],
  ] as const)('packages %s with a distinct identity and the intended update/deep-link settings', (_, canary, preview, appId, productName) => {
    vi.stubEnv('KIMI_DESKTOP_CANARY', String(canary));
    vi.stubEnv('KIMI_DESKTOP_PREVIEW', String(preview));
    const config = require(configPath);
    expect(config.appId).toBe(appId);
    expect(config.productName).toBe(productName);
    expect(config.protocols).toHaveLength(canary || preview ? 0 : 1);
    expect(config.publish === null).toBe(preview);
    if (preview) expect(config.mac.artifactName).toBe('KimiCodePreview-${version}-${os}-${arch}.${ext}');
    if (preview) {
      expect(config.win.artifactName).toBe('KimiCodePreview-${version}-${os}-${arch}.${ext}');
      expect(config.win.icon).toBe('build/icon-preview.ico');
      expect(config.win.extraResources).toEqual([{ from: 'build/icon-preview.ico', to: 'build/icon.ico' }]);
    }
    const channel = preview ? 'preview' : canary ? 'canary' : null;
    expect(config.mac.icon).toBe(channel ? `build/icon-${channel}.icns` : undefined);
    expect(config.mac.extraResources).toEqual(channel
      ? [
          { from: `build/icon-${channel}.png`, to: 'build/icon.png' },
          { from: `build/icon-${channel}-dark.png`, to: 'build/icon-dark.png' },
        ]
      : [{ from: 'build/', to: 'build/', filter: ['icon.png', 'icon-dark.png'] }]);
  });

  it('does not embed the stable Tahoe icon catalog in Preview packages', async () => {
    vi.stubEnv('KIMI_DESKTOP_CANARY', 'false');
    vi.stubEnv('KIMI_DESKTOP_PREVIEW', 'true');
    const config = require(configPath);
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    await config.afterPack({ electronPlatformName: 'darwin' });
    expect(exists).not.toHaveBeenCalled();
  });

  it.each(['', '-dark'])('ships a green Preview Dock icon with the original geometry for theme "%s"', async (theme) => {
    const stable = PNG.sync.read(fs.readFileSync(new URL(`../../../build/icon${theme}.png`, import.meta.url)));
    const preview = PNG.sync.read(fs.readFileSync(new URL(`../../../build/icon-preview${theme}.png`, import.meta.url)));
    expect({ width: preview.width, height: preview.height }).toEqual({ width: stable.width, height: stable.height });
    expect(preview.width).toBe(512);
    expect(preview.height).toBe(512);
    expect(preview.data.filter((_, i) => i % 4 === 3)).toEqual(stable.data.filter((_, i) => i % 4 === 3));
    let greenPixels = 0;
    for (let i = 0; i < preview.data.length; i += 4) {
      const [r, g, b, a] = preview.data.subarray(i, i + 4);
      if (a! > 0 && g! > r! + 30 && g! > b! + 30) greenPixels++;
    }
    expect(greenPixels).toBeGreaterThan(1000);
  });

  it('ships a complete Preview installation icon', () => {
    const icon = fs.readFileSync(new URL('../../../build/icon-preview.icns', import.meta.url));
    expect(icon.toString('ascii', 0, 4)).toBe('icns');
    expect(icon.readUInt32BE(4)).toBe(icon.length);
  });

  it('ships a multi-size Windows Preview installation icon', () => {
    const icon = fs.readFileSync(new URL('../../../build/icon-preview.ico', import.meta.url));
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    expect(icon.readUInt16LE(4)).toBe(7);
    for (let index = 0; index < 7; index++) {
      const entry = 6 + index * 16;
      const size = icon.readUInt32LE(entry + 8);
      const offset = icon.readUInt32LE(entry + 12);
      expect(offset + size).toBeLessThanOrEqual(icon.length);
      expect(icon.subarray(offset, offset + 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  });

  it('rejects conflicting build identities', () => {
    vi.stubEnv('KIMI_DESKTOP_CANARY', 'true');
    vi.stubEnv('KIMI_DESKTOP_PREVIEW', 'true');
    expect(() => require(configPath)).toThrow('mutually exclusive');
  });
});
