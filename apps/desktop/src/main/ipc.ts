import { app, dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { getMainWindow, showMainWindow, applyWindowVibrancy, sendToRenderer } from './window';
import { listAvailableOpenInApps, openInApp } from './open-in';
import { getTerminalManager, initTerminalManager } from './terminal';
import { startShellEnvProbe } from './shell-env';
import {
  getUpdateAutoDownload,
  getUpdateStatus,
  requestUpdateCheck,
  requestUpdateDownload,
  requestUpdateInstall,
  setUpdateAutoDownload,
} from './updater';
import { asTrayAttention, setTrayAttention, setTrayLocale } from './tray';
import { setContextMenuLocale } from './context-menu';
import { asJumpListWorkspaces, setJumpListLocale, updateJumpList } from './jump-list';
import { popupWindowsMenu, setMenuLocale, setMenuShortcuts, setMenuSuspended, setTerminalMenuFocus, onTerminalMenuFocus } from './menu';
import { setGlobalShortcut, setGlobalShortcutSuspended, setGlobalShortcutTerminalFocus } from './shortcuts';
import { isVibrancyEnabled, markOnboarded, setVibrancyEnabled } from './ui-state';
import { isDockIconChoice, setDockIconChoice } from './dock-icon';
import { log, redactUrlForLog } from './log';
import { updateServerRegionToken } from './region';
import { createRendererLogWriter } from './renderer-log';
import {
  rendererTrackEventSchema,
  type RendererTrackEvent,
} from '../shared/track-events';
import { trackDesktopEvent } from './track';
import { IPC, type ColorScheme, type WindowsMenuId } from './ipc-channels';

function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isWindowsMenuId(value: unknown): value is WindowsMenuId {
  return value === 'file' || value === 'edit' || value === 'view' || value === 'help';
}

/** Terminal create payload (renderer only picks cwd/size — the shell itself
    is resolved main-side, never from renderer input). */
function asTerminalCreateOptions(value: unknown): { cwd?: string; cols?: number; rows?: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const options: { cwd?: string; cols?: number; rows?: number } = {};
  if (typeof raw['cwd'] === 'string' && raw['cwd'] !== '') options.cwd = raw['cwd'];
  if (typeof raw['cols'] === 'number' && Number.isFinite(raw['cols'])) options.cols = raw['cols'];
  if (typeof raw['rows'] === 'number' && Number.isFinite(raw['rows'])) options.rows = raw['rows'];
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

export function registerIpcHandlers(): void {
  ipcMain.on(IPC.theme, (_event, scheme: unknown) => {
    if (isColorScheme(scheme)) {
      nativeTheme.themeSource = scheme;
    }
  });
  // Dock tile preference from the settings UI (light/dark; dock-icon.ts).
  ipcMain.on(IPC.dockIconChoice, (_event, choice: unknown) => {
    if (isDockIconChoice(choice)) setDockIconChoice(choice);
  });
  ipcMain.handle(IPC.openExternal, (_event, url: string) =>
    // The rejection still propagates to the renderer's invoke promise; log it
    // main-side too so packaged builds keep a record (renderer console is
    // invisible there). The URL is redacted before hitting the log file.
    shell.openExternal(url).catch((error: unknown) => {
      log.error(`[kimi-desktop] openExternal failed: ${redactUrlForLog(url)}`, error);
      throw error;
    }),
  );
  // Renderer-collected server credentials (ServerAuthDialog on a credential-
  // protected external server): keep the region probe's bearer in sync.
  ipcMain.handle(IPC.serverCredential, (_event, token: unknown) => {
    if (typeof token === 'string' && token.length > 0) {
      updateServerRegionToken(token);
    }
  });
  // File dialogs: the renderer asks (whitelisted `showOpenDialog`/`showSaveDialog`),
  // the main process opens the native dialog and returns the user's selection.
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
  // "Open workspace in <app>": the main process owns both the installed-app
  // catalog and the actual launch (open-in.ts); results are forwarded verbatim.
  ipcMain.handle(IPC.openInList, () => listAvailableOpenInApps());
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
  // Initial fullscreen state for the renderer (transitions are pushed over
  // `IPC.fullscreenChanged` by window.ts); needed when the page (re)loads while
  // the window is already full-screen.
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
      setContextMenuLocale(locale);
      setJumpListLocale(locale);
    }
  });
  // Windows Jump List: the renderer pushes its recent workspaces (name +
  // root) whenever they change (useJumpList.ts); malformed payloads drop.
  ipcMain.on(IPC.jumpList, (_event, payload: unknown) => {
    const workspaces = asJumpListWorkspaces(payload);
    if (workspaces !== null) {
      updateJumpList(workspaces);
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
  // xterm focus in the native terminal: strip menu accelerators (Windows also
  // strips the edit menu's Ctrl-chords) so control keys reach the PTY.
  ipcMain.on(IPC.menuTerminalFocus, (_event, focused: unknown) => {
    if (typeof focused === 'boolean') {
      setTerminalMenuFocus(focused);
    }
  });
  // The OS-level summon shortcut suspends with the menu accelerators —
  // globalShortcut would eat a Ctrl-bound chord before the PTY ever sees it.
  onTerminalMenuFocus(setGlobalShortcutTerminalFocus);
  // The summon-app global shortcut follows the renderer's customizable binding
  // (canonical keymap format). Registration lives in the main process because
  // globalShortcut must fire even when the window is hidden or unfocused.
  // Returns whether the binding went live (false = OS refused it, the previous
  // working shortcut stays) so the renderer can flag dead bindings.
  ipcMain.handle(IPC.globalShortcut, (_event, payload: unknown) => {
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
  // hide-on-close the window may be alive but hidden, and the web
  // window.focus() can't un-hide it — only the main process can.
  ipcMain.on(IPC.showWindow, () => {
    showMainWindow();
    trackDesktopEvent('native_ipc_used', { channel: 'show-window' });
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
    if (typeof enabled !== 'boolean') return;
    setVibrancyEnabled(enabled);
    applyWindowVibrancy(enabled);
    trackDesktopEvent('native_ipc_used', { channel: 'vibrancy' });
  });
  ipcMain.handle(IPC.getVibrancy, () => isVibrancyEnabled());
  // Renderer diagnostics → the same log file the main process writes (the
  // sandboxed renderer has no fs access). Validation, redaction and rate
  // limiting all live in renderer-log.ts; this handler must never throw.
  ipcMain.on(IPC.rendererLog, (_event, payload: unknown) => {
    rendererLogWriter(payload);
  });
  // Renderer telemetry: events are whitelisted and re-validated at this trust
  // boundary, then flow through the same CloudAppender pipeline as
  // main-process events. No-op until telemetry is wired (telemetry.ts).
  ipcMain.on(IPC.track, (_event, eventName: unknown, payload: unknown) => {
    const parsed = asRendererTrackEvent(eventName, payload);
    if (parsed !== null) {
      trackDesktopEvent(parsed.event, parsed.properties);
    }
  });
  // Native embedded terminal (main/terminal.ts): PTYs live in THIS process;
  // the renderer picks cwd and size, the shell is resolved main-side.
  initTerminalManager({
    // Lazy: app.getLocale() is only valid after app-ready, which is later
    // than this registration.
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
  ipcMain.handle(IPC.terminalCreate, async (event, payload: unknown) => {
    const win = getMainWindow();
    if (win === null || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error('terminal-create: unknown sender');
    }
    const manager = getTerminalManager();
    const gen = manager.generation();
    // Wait out the memoized shell-env probe so the first PTY inherits the
    // user's PATH on GUI launches.
    await startShellEnvProbe();
    // A reload during the probe bumps the generation — spawning now would
    // orphan the PTY.
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
