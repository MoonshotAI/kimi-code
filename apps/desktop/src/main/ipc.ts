import { dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';

import { getMainWindow, showMainWindow, applyWindowVibrancy } from './window';
import { readServerToken } from './connect';
import { listAvailableOpenInApps, openInApp } from './open-in';
import {
  getUpdateAutoDownload,
  getUpdateStatus,
  requestUpdateCheck,
  requestUpdateDownload,
  requestUpdateInstall,
  setUpdateAutoDownload,
} from './updater';
import { asTrayAttention, setTrayAttention, setTrayLocale } from './tray';
import { setMenuLocale, setMenuShortcuts, setMenuSuspended } from './menu';
import { setGlobalShortcut, setGlobalShortcutSuspended } from './shortcuts';
import { isVibrancyEnabled, markOnboarded, setVibrancyEnabled } from './ui-state';
import { isDockIconChoice, osAppearance, setDockIconChoice } from './dock-icon';
import { asRendererTrackEvent, trackDesktopEvent } from './track';
import { IPC, type ColorScheme } from './ipc-channels';

function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function registerIpcHandlers(): void {
  // native_ipc_used fires only for the curated user-initiated channels below
  // (channel reported without the `kimi:` prefix); sync/poll channels would
  // drown the signal and stay silent.
  ipcMain.on(IPC.theme, (_event, scheme: unknown) => {
    trackDesktopEvent('native_ipc_used', { channel: 'theme' });
    if (isColorScheme(scheme)) {
      nativeTheme.themeSource = scheme;
    }
  });
  // Dock tile preference from the settings UI (light/dark/auto; dock-icon.ts).
  ipcMain.on(IPC.dockIconChoice, (_event, choice: unknown) => {
    trackDesktopEvent('native_ipc_used', { channel: 'dock-icon-choice' });
    if (isDockIconChoice(choice)) setDockIconChoice(choice);
  });
  ipcMain.handle(IPC.osAppearance, () => osAppearance());
  ipcMain.handle(IPC.openExternal, (_event, url: string) => shell.openExternal(url));
  // File dialogs: the renderer asks (whitelisted `showOpenDialog`/`showSaveDialog`),
  // the main process opens the native dialog and returns the user's selection.
  ipcMain.handle(IPC.dialogOpen, (_event, opts: OpenDialogOptions = {}) => {
    trackDesktopEvent('native_ipc_used', { channel: 'dialog-open' });
    const win = getMainWindow();
    return win === null || win.isDestroyed()
      ? dialog.showOpenDialog(opts)
      : dialog.showOpenDialog(win, opts);
  });
  ipcMain.handle(IPC.dialogSave, (_event, opts: SaveDialogOptions = {}) => {
    trackDesktopEvent('native_ipc_used', { channel: 'dialog-save' });
    const win = getMainWindow();
    return win === null || win.isDestroyed()
      ? dialog.showSaveDialog(opts)
      : dialog.showSaveDialog(win, opts);
  });
  // "Open workspace in <app>": the main process owns both the installed-app
  // catalog and the actual launch (open-in.ts); results are forwarded verbatim.
  ipcMain.handle(IPC.openInList, () => {
    trackDesktopEvent('native_ipc_used', { channel: 'open-in-list' });
    return listAvailableOpenInApps();
  });
  ipcMain.handle(IPC.openInApp, (_event, appId: unknown, path: unknown) => {
    trackDesktopEvent('native_ipc_used', { channel: 'open-in' });
    if (typeof appId !== 'string' || typeof path !== 'string' || path.trim() === '') {
      return { ok: false as const, error: 'invalid open-in arguments' };
    }
    return openInApp(appId, path);
  });
  // Token for the renderer's credentialStore (Task 4.5); read in main, never fs in renderer.
  ipcMain.handle(IPC.getServerToken, () => readServerToken());
  // Initial fullscreen state for the renderer (transitions are pushed over
  // `IPC.fullscreenChanged` by window.ts); needed when the page (re)loads while
  // the window is already full-screen.
  ipcMain.handle(IPC.isFullscreen, () => {
    const win = getMainWindow();
    return win !== null && !win.isDestroyed() && win.isFullScreen();
  });
  // Auto-update: the sidebar banner reads the current status once (reload
  // recovery — transitions stream over IPC.updateStatus) and fires the two
  // user actions. No-ops in dev (see updater.ts).
  ipcMain.handle(IPC.updateGetStatus, () => getUpdateStatus());
  // Manual "check for updates" (settings → advanced): resolves with the
  // outcome so the renderer can show inline feedback; 'unsupported' in dev.
  ipcMain.handle(IPC.updateCheck, () => requestUpdateCheck());
  ipcMain.handle(IPC.updateDownload, () => requestUpdateDownload());
  ipcMain.handle(IPC.updateInstall, () => requestUpdateInstall());
  // Background-download preference (settings → advanced): persisted in
  // ui-state.json even in dev (no controller), so the toggle round-trips.
  ipcMain.handle(IPC.updateGetAutoDownload, () => getUpdateAutoDownload());
  ipcMain.handle(IPC.updateSetAutoDownload, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') {
      setUpdateAutoDownload(enabled);
    }
  });
  // Tray attention badge: the renderer pushes {unread, approvals, questions}
  // totals whenever they change (useTrayAttention.ts); tray.ts renders them as
  // the macOS menu-bar count + tooltip/menu breakdown. Malformed payloads drop.
  ipcMain.on(IPC.trayAttention, (_event, payload: unknown) => {
    const attention = asTrayAttention(payload);
    if (attention !== null) {
      setTrayAttention(attention);
    }
  });
  // The renderer's in-app language drives the main-process strings (tray
  // labels/tooltip, application menu). Until the first push the OS language
  // is the fallback.
  ipcMain.on(IPC.locale, (_event, locale: unknown) => {
    if (locale === 'en' || locale === 'zh') {
      setTrayLocale(locale);
      setMenuLocale(locale);
    }
  });
  // The renderer's customizable shortcut bindings (canonical keymap format,
  // action id → binding | null) — the matching menu items show them as
  // accelerators (menu.ts owns the conversion + rebuild).
  ipcMain.on(IPC.menuShortcut, (_event, payload: unknown) => {
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
  // The settings panel's shortcut recorder silences every menu accelerator
  // while it listens (they would otherwise fire before the renderer sees the
  // key — recording ⌘R would reload the app).
  ipcMain.on(IPC.menuSuspend, (_event, suspended: unknown) => {
    if (typeof suspended === 'boolean') {
      setMenuSuspended(suspended);
    }
  });
  // The summon-app global shortcut follows the renderer's customizable binding
  // (canonical keymap format). Registration lives in the main process because
  // globalShortcut must fire even when the window is hidden or unfocused.
  // Returns whether the binding went live (false = OS refused it, the previous
  // working shortcut stays) so the renderer can flag dead bindings.
  ipcMain.handle(IPC.globalShortcut, (_event, payload: unknown) => {
    trackDesktopEvent('native_ipc_used', { channel: 'global-shortcut' });
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return false;
    }
    const { action, binding } = payload as Record<string, unknown>;
    if (action !== 'summonApp' || (binding !== null && typeof binding !== 'string')) {
      return false;
    }
    return setGlobalShortcut(binding as string | null);
  });
  // Same recording problem as the menu: the current OS-level combo would be
  // consumed by the system and never reach the renderer's recorder, so the
  // panel unregisters it for the duration of a recording. Returns whether the
  // requested binding went live on resume (false = OS refused it, committed
  // binding restored) so the panel can roll back a dead override.
  ipcMain.handle(IPC.globalShortcutSuspend, (_event, suspended: unknown) => {
    if (typeof suspended !== 'boolean') {
      return false;
    }
    return setGlobalShortcutSuspended(suspended);
  });
  // Renderer-initiated "bring the window back" (notification clicks): with
  // macOS hide-on-close the window may be alive but hidden, and the web
  // window.focus() can't un-hide it — only the main process can.
  ipcMain.on(IPC.showWindow, () => {
    trackDesktopEvent('native_ipc_used', { channel: 'show-window' });
    showMainWindow();
  });
  // Onboarding completed (or skipped to the same effect): persist the flag in
  // ui-state.json so it survives dev-server port shifts (renderer localStorage
  // is origin-scoped; this file is not).
  ipcMain.on(IPC.setOnboarded, () => {
    markOnboarded();
  });
  // Frosted-sidebar switch (macOS, settings → appearance): persist main-side
  // (window creation reads it before the renderer exists — no boot flicker),
  // then live-apply to the created window. Initial value goes back over
  // IPC.getVibrancy.
  ipcMain.on(IPC.vibrancy, (_event, enabled: unknown) => {
    trackDesktopEvent('native_ipc_used', { channel: 'vibrancy' });
    if (typeof enabled !== 'boolean') return;
    setVibrancyEnabled(enabled);
    applyWindowVibrancy(enabled);
  });
  ipcMain.handle(IPC.getVibrancy, () => isVibrancyEnabled());
  // Renderer telemetry: events are whitelisted and re-validated at this trust
  // boundary (track.ts), then flow through the same CloudAppender pipeline as
  // main-process events. No-op until telemetry is wired (telemetry.ts).
  ipcMain.on(IPC.track, (_event, eventName: unknown, payload: unknown) => {
    const parsed = asRendererTrackEvent(eventName, payload);
    if (parsed !== null) {
      trackDesktopEvent(parsed.event, parsed.properties);
    }
  });
}
