import { app, ipcMain, nativeTheme } from 'electron';
import { getMainWindow, showMainWindow, applyWindowVibrancy, markQuitting, markRendererUiMounted, windowForWebContents } from '../../window/main-window';
import { asTrayAttention, setTrayAttention, setTrayLocale } from '../../shell/tray';
import { setContextMenuLocale, showSelectionContextMenu } from '../../shell/context-menu';
import { resolveQuitConfirmResponse, setQuitConfirmLocale, shouldBlockQuit } from '../../app/quit-confirm';
import { asJumpListWorkspaces, setJumpListLocale, updateJumpList } from '../../shell/jump-list';
import { popupWindowsMenu, setMenuLocale, setMenuShortcuts, setMenuSuspended, setTerminalMenuFocus, onTerminalMenuFocus } from '../../shell/menu';
import { setGlobalShortcutForAction, setGlobalShortcutSuspended, setGlobalShortcutTerminalFocus } from '../../shell/shortcuts';
import { isLinuxNativeTitleBar, isVibrancyEnabled, markOnboarded, setColorScheme, setLinuxNativeTitleBar, setVibrancyEnabled } from '../../app/ui-state';
import { isDockIconChoice, setDockIconChoice } from '../../shell/dock-icon';
import { setScreenshotLocale } from '../../screenshot/controller';
import { recordRendererMilestone } from '../../diagnostics/startup-milestones';
import { trackDesktopEvent } from '../../diagnostics/track';
import { IPC, type ColorScheme, type WindowsMenuId } from '../ipc-channels';
import { isMainRendererSender } from '../sender';

function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isWindowsMenuId(value: unknown): value is WindowsMenuId {
  return value === 'file' || value === 'edit' || value === 'view' || value === 'help';
}

export function registerWindowShellIpc(): void {
  ipcMain.on(IPC.theme, (_event, scheme: unknown) => {
    if (isColorScheme(scheme)) {
      nativeTheme.themeSource = scheme;
      setColorScheme(scheme);
    }
  });
  ipcMain.on(IPC.dockIconChoice, (_event, choice: unknown) => {
    if (isDockIconChoice(choice)) setDockIconChoice(choice);
  });
  ipcMain.handle(IPC.isFullscreen, () => {
    const win = getMainWindow();
    return win !== null && !win.isDestroyed() && win.isFullScreen();
  });
  ipcMain.handle(IPC.menuPopup, (event, request: unknown) => {
    const win = getMainWindow();
    if (
      win === null ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      request === null ||
      typeof request !== 'object'
    ) {
      return { opened: false };
    }
    const { id, x, y } = request as Record<string, unknown>;
    if (!isWindowsMenuId(id) || typeof x !== 'number' || typeof y !== 'number') {
      return { opened: false };
    }
    return popupWindowsMenu(id, x, y);
  });
  ipcMain.handle(IPC.quitConfirmResponse, (event, payload: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return;
    if (payload === null || typeof payload !== 'object') return;
    const { choice, requestId, continueSessions } = payload as {
      choice?: unknown;
      requestId?: unknown;
      continueSessions?: unknown;
    };
    if (
      (choice === 'quit' || choice === 'cancel' || choice === 'unavailable') &&
      typeof requestId === 'number'
    ) {
      resolveQuitConfirmResponse(choice, requestId, continueSessions === true);
    }
  });
  ipcMain.on(IPC.trayAttention, (_event, payload: unknown) => {
    const attention = asTrayAttention(payload);
    if (attention !== null) {
      setTrayAttention(attention);
    }
  });
  ipcMain.on(IPC.locale, (_event, locale: unknown) => {
    if (locale === 'en' || locale === 'zh') {
      setTrayLocale(locale);
      setMenuLocale(locale);
      setContextMenuLocale(locale);
      setJumpListLocale(locale);
      setScreenshotLocale(locale);
      setQuitConfirmLocale(locale);
    }
  });
  ipcMain.on(IPC.jumpList, (_event, payload: unknown) => {
    const workspaces = asJumpListWorkspaces(payload);
    if (workspaces !== null) {
      updateJumpList(workspaces);
    }
  });
  ipcMain.on(IPC.menuShortcut, (event, payload: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }
    const bindings: Record<string, string | null> = {};
    for (const [id, value] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof value === 'string' || value === null) {
        bindings[id] = value;
      }
    }
    setMenuShortcuts(bindings);
  });
  ipcMain.on(IPC.menuSuspend, (_event, suspended: unknown) => {
    if (typeof suspended === 'boolean') {
      setMenuSuspended(suspended);
    }
  });
  ipcMain.on(IPC.menuTerminalFocus, (_event, focused: unknown) => {
    if (typeof focused === 'boolean') {
      setTerminalMenuFocus(focused);
    }
  });
  onTerminalMenuFocus(setGlobalShortcutTerminalFocus);
  ipcMain.handle(IPC.globalShortcut, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'invalid' };
    }
    const { action, binding } = payload as Record<string, unknown>;
    if ((action !== 'summonApp' && action !== 'captureScreenshot') || (binding !== null && typeof binding !== 'string')) {
      return { ok: false, reason: 'invalid' };
    }
    return setGlobalShortcutForAction(action, binding as string | null);
  });
  ipcMain.handle(IPC.globalShortcutSuspend, (_event, suspended: unknown) => {
    if (typeof suspended !== 'boolean') {
      return false;
    }
    return setGlobalShortcutSuspended(suspended);
  });
  ipcMain.on(IPC.showWindow, () => {
    showMainWindow();
    trackDesktopEvent('native_ipc_used', { channel: 'show-window' });
  });
  ipcMain.on(IPC.hideWindow, (event) => {
    windowForWebContents(event.sender)?.close();
    trackDesktopEvent('native_ipc_used', { channel: 'hide-window' });
  });
  ipcMain.on(IPC.selectionContextMenu, (event, selectionText: unknown) => {
    showSelectionContextMenu(event.sender, selectionText);
  });
  ipcMain.on(IPC.setOnboarded, () => {
    markOnboarded();
  });
  ipcMain.on(IPC.vibrancy, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    setVibrancyEnabled(enabled);
    applyWindowVibrancy(enabled);
    trackDesktopEvent('native_ipc_used', { channel: 'vibrancy' });
  });
  ipcMain.handle(IPC.getVibrancy, () => isVibrancyEnabled());
  ipcMain.handle(IPC.linuxNativeTitleBar, async (event, enabled: unknown) => {
    if (process.platform !== 'linux' || typeof enabled !== 'boolean') return { status: 'unavailable' };
    if (event.sender !== getMainWindow()?.webContents) return { status: 'unavailable' };
    if (await shouldBlockQuit(getMainWindow(), { interceptWindowClose: false })) {
      return { status: 'cancelled' };
    }
    setLinuxNativeTitleBar(enabled);
    if (isLinuxNativeTitleBar() !== enabled) return { status: 'error' };
    trackDesktopEvent('native_ipc_used', { channel: 'linux-native-titlebar' });
    setImmediate(() => {
      markQuitting();
      app.relaunch();
      app.quit();
    });
    return { status: 'relaunching' };
  });
  ipcMain.on(IPC.startupMilestone, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const milestone = recordRendererMilestone(payload);
    if (milestone?.milestone !== 'ui-mounted') return;
    const frame = event.senderFrame;
    if (frame !== null && frame === event.sender.mainFrame) markRendererUiMounted(frame.url);
  });
}
