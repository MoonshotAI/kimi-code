import { app, clipboard, dialog, ipcMain, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions, WebContents } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { getMainWindow, sendToRenderer } from '../../window/main-window';
import { listAvailableOpenInApps, openInApp } from '../../system/open-in';
import { getTerminalManager, initTerminalManager, type NativeTerminalCreateOptions } from '../../terminal/manager';
import { normalizeTerminalSshTarget } from '../../../shared/terminal-activity';
import { startShellEnvProbe } from '../../system/shell-env';
import { isPowerSaveBlockerEnabled } from '../../system/power-save-blocker';
import { getPreventSleepState, setLidSleepPreventionEnabled, setSystemSleepPreventionEnabled } from '../../system/prevent-lid-sleep';
import { isSleepPreventionMode } from '../../../shared/prevent-sleep';
import { isHttpUrl } from '../../shell/external-links';
import { cancelScreenshotCapture, captureScreenshot } from '../../screenshot/controller';
import { log, redactUrlForLog } from '../../diagnostics/log';
import { updateServerRegionToken } from '../../server/region';
import { asProviderModelsFetchRequest, fetchProviderModelsViaNet } from '../../system/provider-models-fetch';
import { createRendererLogWriter } from '../../diagnostics/renderer-log';
import { collectFeedbackDiagnosticsArchive } from '../../diagnostics/diagnostics-export';
import {
  rendererTrackEventSchema,
  type RendererTrackEvent,
} from '../../../shared/track-events';
import { trackDesktopEvent } from '../../diagnostics/track';
import { IPC } from '../ipc-channels';
import { isMainRendererSender } from '../sender';

function asTerminalCreateOptions(value: unknown): NativeTerminalCreateOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const options: NativeTerminalCreateOptions = {};
  if (typeof raw['cwd'] === 'string' && raw['cwd'] !== '') options.cwd = raw['cwd'];
  if (typeof raw['cols'] === 'number' && Number.isFinite(raw['cols'])) options.cols = raw['cols'];
  if (typeof raw['rows'] === 'number' && Number.isFinite(raw['rows'])) options.rows = raw['rows'];
  const ssh = normalizeTerminalSshTarget(raw['ssh']);
  if (ssh !== undefined) options.ssh = ssh;
  return options;
}

function asRendererTrackEvent(
  event: unknown,
  payload: unknown,
): RendererTrackEvent | null {
  const result = rendererTrackEventSchema.safeParse({ event, properties: payload });
  return result.success ? result.data : null;
}

const rendererLogWriter = createRendererLogWriter();

function rendererLogSource(sender: WebContents): string | undefined {
  try {
    return `r${sender.getOSProcessId()}`;
  } catch {
    return undefined;
  }
}

export function registerSystemTerminalIpc(): void {
  ipcMain.handle(IPC.openExternal, (_event, url: string) => {
    if (!isHttpUrl(url)) {
      log.error(`[kimi-desktop] openExternal rejected non-http(s) url: ${redactUrlForLog(url)}`);
      throw new Error('openExternal only allows http(s) URLs');
    }
    return shell.openExternal(url).catch((error: unknown) => {
      log.error(`[kimi-desktop] openExternal failed: ${redactUrlForLog(url)}`, error);
      throw error;
    });
  });
  ipcMain.handle(IPC.writeClipboardText, (_event, text: unknown) => {
    if (typeof text !== 'string') return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle(IPC.collectFeedbackDiagnostics, (event) => {
    if (!isMainRendererSender(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Feedback diagnostics are only available to the main window');
    }
    return collectFeedbackDiagnosticsArchive();
  });
  ipcMain.handle(IPC.serverCredential, (_event, token: unknown) => {
    if (typeof token === 'string' && token.length > 0) {
      updateServerRegionToken(token);
    }
  });
  ipcMain.handle(IPC.dialogOpen, async (_event, opts: OpenDialogOptions = {}) => {
    const win = getMainWindow();
    const result = await (win === null || win.isDestroyed()
      ? dialog.showOpenDialog(opts)
      : dialog.showOpenDialog(win, opts));
    trackDesktopEvent('native_ipc_used', { channel: 'dialog-open' });
    return result;
  });
  ipcMain.handle(IPC.dialogSave, async (_event, opts: SaveDialogOptions = {}) => {
    const win = getMainWindow();
    const result = await (win === null || win.isDestroyed()
      ? dialog.showSaveDialog(opts)
      : dialog.showSaveDialog(win, opts));
    trackDesktopEvent('native_ipc_used', { channel: 'dialog-save' });
    return result;
  });
  ipcMain.handle(IPC.openInList, (_event, filePath: unknown) =>
    listAvailableOpenInApps({
      filePath: typeof filePath === 'string' && filePath.trim() !== '' ? filePath : undefined,
    }),
  );
  ipcMain.handle(IPC.openInApp, async (_event, appId: unknown, path: unknown) => {
    if (typeof appId !== 'string' || typeof path !== 'string' || path.trim() === '') {
      return { ok: false as const, error: 'invalid open-in arguments' };
    }
    const result = await openInApp(appId, path);
    if (result.ok) {
      trackDesktopEvent('native_ipc_used', { channel: 'open-in' });
    }
    return result;
  });
  ipcMain.handle(IPC.providerModelsFetch, async (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('provider-models-fetch: unknown sender');
    const request = asProviderModelsFetchRequest(payload);
    if (request === null) throw new Error('provider-models-fetch: invalid request');
    return await fetchProviderModelsViaNet(request);
  });
  ipcMain.handle(IPC.screenshotCapture, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('screenshot-capture: unknown sender');
    return captureScreenshot();
  });
  ipcMain.on(IPC.screenshotCancel, (event) => {
    if (!isMainRendererSender(event.sender)) return;
    cancelScreenshotCapture();
  });
  ipcMain.handle(IPC.preventSystemSleep, async (_event, mode: unknown) => {
    if (!isSleepPreventionMode(mode)) return getPreventSleepState();
    const state = await setSystemSleepPreventionEnabled(mode);
    trackDesktopEvent('native_ipc_used', { channel: 'prevent-system-sleep' });
    return state;
  });
  ipcMain.handle(IPC.getPreventSystemSleep, () => isPowerSaveBlockerEnabled());
  ipcMain.handle(IPC.preventSleepState, () => getPreventSleepState());
  ipcMain.handle(IPC.setPreventLidSleep, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return getPreventSleepState();
    const state = await setLidSleepPreventionEnabled(enabled);
    trackDesktopEvent('native_ipc_used', { channel: 'prevent-lid-sleep' });
    return state;
  });
  ipcMain.on(IPC.rendererLog, (event, payload: unknown) => {
    rendererLogWriter(payload, rendererLogSource(event.sender));
  });
  ipcMain.on(IPC.track, (_event, eventName: unknown, payload: unknown) => {
    const parsed = asRendererTrackEvent(eventName, payload);
    if (parsed !== null) {
      trackDesktopEvent(parsed.event, parsed.properties);
    }
  });
  initTerminalManager({
    locale: () => {
      try {
        return app.getLocale();
      } catch {
        return 'en';
      }
    },
    homeDir: homedir(),
    pathExists: (path) => existsSync(path),
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    pushOutput: (id, data) => sendToRenderer(IPC.terminalOutput, { id, data }),
    pushExit: (id, exitCode) => sendToRenderer(IPC.terminalExit, { id, exitCode }),
  });
  ipcMain.handle(IPC.terminalInspect, (event, ids: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('terminal-inspect: unknown sender');
    if (!Array.isArray(ids) || ids.length > 512 || !ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
      throw new Error('terminal-inspect: invalid terminal ids');
    }
    return getTerminalManager().inspect([...new Set(ids)]);
  });
  ipcMain.handle(IPC.terminalCreate, async (event, payload: unknown) => {
    const win = getMainWindow();
    if (win === null || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error('terminal-create: unknown sender');
    }
    const manager = getTerminalManager();
    const gen = manager.generation();
    await startShellEnvProbe();
    const winAfter = getMainWindow();
    if (
      manager.generation() !== gen ||
      winAfter === null ||
      winAfter.isDestroyed() ||
      event.sender !== winAfter.webContents
    ) {
      throw new Error('terminal-create superseded by a renderer navigation');
    }
    return manager.create(asTerminalCreateOptions(payload));
  });
  ipcMain.on(IPC.terminalInput, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { id, data } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof data !== 'string') return;
    getTerminalManager().write(id, data);
  });
  ipcMain.on(IPC.terminalResize, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { id, cols, rows } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') return;
    if (typeof cols !== 'number' || !Number.isFinite(cols)) return;
    if (typeof rows !== 'number' || !Number.isFinite(rows)) return;
    getTerminalManager().resize(id, cols, rows);
  });
  ipcMain.on(IPC.terminalClose, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { id } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') return;
    getTerminalManager().close(id);
  });
}
