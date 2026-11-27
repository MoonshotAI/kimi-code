import { app, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  getUpdateAutoDownload,
  getUpdateStatus,
  requestUpdateCheck,
  requestUpdateDownload,
  requestUpdateInstall,
  setUpdateAutoDownload,
} from '../../release/updater';
import { getCanaryInfo } from '../../release/canary';
import { shouldBlockQuit } from '../../app/quit-confirm';
import { getMainWindow } from '../../window/window-registry';
import { getRemoteControlRestoreState, setRemoteControlPreviousEnabled, setRemoteControlRestoreEnabled } from '../../app/ui-state';
import { stableSettingsPrecheck, stableUserDataDir, writeImportMarker } from '../../release/stable-settings-import';
import { log } from '../../diagnostics/log';
import { markCleanExit } from '../../app/launch-state';
import {
  readRuntimeEnvironmentOverrides,
  restoreRuntimeEnvironmentForRelaunch,
  runtimeEnvironmentCustomizationEnabled,
  RuntimeEnvironmentFieldError,
  writeRuntimeEnvironmentOverrides,
} from '../../app/runtime-environment';
import { IPC } from '../ipc-channels';

export function registerReleaseIpc(): void {
  ipcMain.handle(IPC.updateGetStatus, () => getUpdateStatus());
  ipcMain.handle(IPC.updateCheck, () => requestUpdateCheck());
  ipcMain.handle(IPC.updateDownload, () => requestUpdateDownload());
  ipcMain.handle(IPC.updateInstall, () => requestUpdateInstall());
  ipcMain.handle(IPC.updateGetAutoDownload, () => getUpdateAutoDownload());
  ipcMain.handle(IPC.updateSetAutoDownload, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') {
      setUpdateAutoDownload(enabled);
    }
  });
  ipcMain.handle(IPC.remoteControlRestoreStateGet, () => getRemoteControlRestoreState());
  ipcMain.handle(IPC.remoteControlRestoreStateSet, (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null) return;
    const value = patch as { restoreEnabled?: unknown; previousEnabled?: unknown };
    if (typeof value.restoreEnabled === 'boolean') setRemoteControlRestoreEnabled(value.restoreEnabled);
    if (typeof value.previousEnabled === 'boolean') setRemoteControlPreviousEnabled(value.previousEnabled);
  });
  const runtimeEnvironmentAllowed = (event: { sender: WebContents }): boolean =>
    runtimeEnvironmentCustomizationEnabled(app.getVersion(), app.isPackaged) && event.sender === getMainWindow()?.webContents;
  const saveRuntimeEnvironment = async (event: { sender: WebContents }, value: unknown, requireEndpoints = true) => {
    if (!runtimeEnvironmentAllowed(event)) return { status: 'unavailable' as const };
    try {
      if (await shouldBlockQuit(getMainWindow(), { interceptWindowClose: false })) {
        return { status: 'cancelled' as const };
      }
      writeRuntimeEnvironmentOverrides(value, undefined, requireEndpoints);
      restoreRuntimeEnvironmentForRelaunch();
    } catch (error) {
      if (error instanceof RuntimeEnvironmentFieldError) return { status: 'invalid' as const, field: error.field };
      log.error('[kimi-desktop] failed to save runtime environment', error);
      return { status: 'error' as const, error: error instanceof Error ? error.message : String(error) };
    }
    setImmediate(() => {
      markCleanExit();
      app.relaunch();
      app.exit(0);
    });
    return { status: 'relaunching' as const };
  };
  ipcMain.handle(IPC.runtimeEnvironmentGet, (event) => {
    if (!runtimeEnvironmentAllowed(event)) return { status: 'unavailable' as const };
    try {
      return { status: 'ok' as const, overrides: readRuntimeEnvironmentOverrides() };
    } catch (error) {
      return { status: 'error' as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC.runtimeEnvironmentSave, (event, value: unknown) => saveRuntimeEnvironment(event, value));
  ipcMain.handle(IPC.runtimeEnvironmentReset, (event) => saveRuntimeEnvironment(event, {}, false));
  ipcMain.handle(IPC.canaryGetInfo, () => getCanaryInfo());
  ipcMain.handle(IPC.canaryImportStableSettings, async () => {
    const precheck = stableSettingsPrecheck(app.getVersion(), process.platform, app.getPath('appData'));
    if (precheck !== 'ok') return { status: precheck };
    if (await shouldBlockQuit(getMainWindow(), { interceptWindowClose: false })) {
      return { status: 'cancelled' };
    }
    try {
      writeImportMarker(app.getPath('userData'), stableUserDataDir(app.getPath('appData')));
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    setImmediate(() => {
      markCleanExit();
      app.relaunch();
      app.exit(0);
    });
    return { status: 'relaunching' };
  });
}
