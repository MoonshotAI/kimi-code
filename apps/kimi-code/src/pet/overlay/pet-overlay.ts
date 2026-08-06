/**
 * Pet overlay — Electron main-process entry (bundled as `dist/pet-overlay.mjs`,
 * executed by the Electron binary spawned from `kimi pet`).
 *
 * Renders a small transparent always-on-top window showing the aggregate
 * status of all reporting Kimi Code sessions. State is pulled from
 * `<dataDir>/pet/sessions/` (written by in-process reporters); this process
 * also maintains the `overlay.json` heartbeat that gates those reporters.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';

import { BrowserWindow, app, ipcMain, screen } from 'electron';

import {
  clampPetBubbleFontSize,
  clampPetScale,
  rankSessionStates,
  readPetSessionStates,
  readPetSettings,
  readPetWindowPosition,
  writePetOverlayHeartbeat,
  writePetSettings,
  writePetWindowPosition,
  type PetOverlayState,
  type PetSessionSummary,
  type PetSettings,
} from '#/pet/state';
import { getPetDir, getPetSkinsDir } from '../dirs';

import RENDERER_HTML from './renderer.html?raw';
import SETTINGS_HTML from './settings.html?raw';

// The window hugs its content: mascot-only when idle, growing upward and
// outward (bottom-center anchored) while a bubble is shown — so the bubble is
// never clipped by the frame, and the transparent window never covers more of
// the desktop than the visible UI.
const WINDOW_MIN_WIDTH = 170;
const WINDOW_MIN_HEIGHT = 160;
const WINDOW_MAX_HEIGHT = 264;
// The max window width follows the bubble's text cap: 20 characters (the
// title limit in renderer.html, ~1em each for CJK) plus the ellipsis glyph
// at the configured font size, plus the bubble's horizontal chrome —
// padding (26) + worst-case action cluster (58) + shadow slack (48) —
// mirrored from renderer.html.
const BUBBLE_TITLE_MAX_CHARS = 20;
const BUBBLE_WIDTH_CHROME = 26 + 58 + 48;
const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 1_000;
const CURSOR_POLL_INTERVAL_MS = 80;

/** `TERM_PROGRAM` value → macOS app name for focusing the session terminal. */
const TERMINAL_APP_NAMES: Record<string, string> = {
  'Warp': 'Warp',
  'iTerm.app': 'iTerm',
  'Apple_Terminal': 'Terminal',
  'WezTerm': 'WezTerm',
  'ghostty': 'Ghostty',
  'kitty': 'kitty',
  'Alacritty': 'Alacritty',
  'Hyper': 'Hyper',
  'Tabby': 'Tabby',
  'vscode': 'Visual Studio Code',
  'zed': 'Zed',
};

// Linux compositors generally need GPU off (and the visuals switch) for a
// transparent window; harmless elsewhere.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();
}

if (!app.requestSingleInstanceLock()) {
  // Another pet is already running: quit WITHOUT touching the ready handler,
  // otherwise this instance would still create a window and timers that then
  // fire against destroyed objects during teardown.
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let lastPayload = '';
/** User settings from the settings window; persisted in settings.json. */
let petSettings: PetSettings = { scale: 1, bubbleFontSize: 13 };
/** CLI version passed via env, shown in the settings window's footer. */
const cliVersion = process.env['KIMI_PET_CLI_VERSION'] ?? '';

app.on('second-instance', () => {
  if (win !== null && !win.isDestroyed()) {
    win.showInactive();
  }
});

/** Load a custom codex-atlas skin selected via `KIMI_PET_SKIN`. */
function loadSkinDataUrl(): string | undefined {
  const name = process.env['KIMI_PET_SKIN'];
  if (name === undefined || name === '') return undefined;
  try {
    const dir = join(getPetSkinsDir(), name);
    const meta = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf-8')) as {
      spritesheetPath?: string;
    };
    const file = join(dir, meta.spritesheetPath ?? 'spritesheet.webp');
    const mime = extname(file) === '.png' ? 'image/png' : 'image/webp';
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * Open (or focus) the settings window. Unlike the transparent pet, this is a
 * regular framed window that takes focus; edits are relayed back over the
 * `pet:update-settings` IPC handled above.
 */
function openSettingsWindow(settingsFile: string): void {
  if (settingsWin !== null && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 372,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Kimi Pet 设置',
    // macOS: keep the traffic lights but hide the title bar itself.
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      // Local, fully-trusted page written by this process; no remote content.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.webContents.on('did-finish-load', () => {
    settingsWin?.webContents.send('pet:settings-init', {
      ...petSettings,
      version: cliVersion,
    });
  });
  void settingsWin.loadFile(settingsFile).then(() => {
    settingsWin?.show();
  });
}

void app.whenReady().then(() => {
  const petDir = getPetDir();
  mkdirSync(petDir, { recursive: true });
  writePetOverlayHeartbeat();
  setInterval(writePetOverlayHeartbeat, HEARTBEAT_INTERVAL_MS);
  petSettings = readPetSettings();

  // The pet is an accessory overlay, not a regular app: no Dock icon, no
  // Mission Control thumbnail. This also keeps macOS from treating the window
  // as a regular document window when joining fullscreen spaces.
  app.dock?.hide();

  const rendererFile = join(petDir, 'overlay-renderer.html');
  writeFileSync(rendererFile, RENDERER_HTML, 'utf-8');
  const settingsFile = join(petDir, 'overlay-settings.html');
  writeFileSync(settingsFile, SETTINGS_HTML, 'utf-8');

  const position = readPetWindowPosition();
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const initialWidth = Math.round(WINDOW_MIN_WIDTH * petSettings.scale);
  const initialHeight = Math.round(WINDOW_MIN_HEIGHT * petSettings.scale);
  win = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x: position?.x ?? workArea.width - initialWidth - 24,
    y: position?.y ?? workArea.height - initialHeight - 24,
    // `panel` (macOS): an NSPanel can join fullscreen spaces as an auxiliary
    // window — without it the system refuses to float the pet over fullscreen
    // apps no matter how high the window level is. Ignored elsewhere.
    type: 'panel',
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // Hidden at construction so the always-on-top / all-spaces flags below are
    // applied before the window is shown; Electron resets the collection
    // behavior on show, so they are re-applied after `showInactive()`.
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      // Local, fully-trusted page written by this process; no remote content.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setHiddenInMissionControl(true);
  void win.loadFile(rendererFile);
  win.showInactive();
  win.on('closed', () => {
    win = null;
  });
  // Re-apply after show: showing can reset the collection behavior, which is
  // what actually gates floating over fullscreen windows.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');

  const persistPosition = (): void => {
    if (win === null) return;
    const [x, y] = win.getPosition();
    writePetWindowPosition({ x, y });
  };
  win.on('moved', persistPosition);
  win.on('move', () => {
    persistPositionDebounced();
  });

  // Right-click "关闭宠物" in the renderer quits the overlay. The pidfile is
  // left behind but `kimi pet` detects the dead pid on the next start.
  ipcMain.on('pet:quit', () => {
    app.quit();
  });

  // Bubble action "open session": focus the terminal app that owns the CLI
  // process. Window-level focus is not portable, so this activates the app.
  ipcMain.on('pet:open-session', (_event, payload: { termProgram?: string }) => {
    if (process.platform !== 'darwin' || payload.termProgram === undefined) return;
    const appName = TERMINAL_APP_NAMES[payload.termProgram] ?? payload.termProgram;
    const child = spawn(
      'osascript',
      ['-e', `tell application "${appName.replaceAll('"', '')}" to activate`],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  });

  // Bubble action "stop": interrupt the session's current turn by sending the
  // CLI process SIGINT (same as pressing Ctrl-C in its terminal).
  ipcMain.on('pet:stop-session', (_event, payload: { pid?: number }) => {
    if (typeof payload.pid !== 'number' || payload.pid === process.pid) return;
    try {
      process.kill(payload.pid, 'SIGINT');
    } catch {
      // Session process already gone.
    }
  });

  // Manual drag from the renderer (see the drag comment in renderer.html).
  let dragOrigin: { baseX: number; baseY: number; startX: number; startY: number } | null = null;
  ipcMain.on('pet:drag-start', (_event, point: { x: number; y: number }) => {
    if (win === null) return;
    const [baseX, baseY] = win.getPosition();
    dragOrigin = { baseX, baseY, startX: point.x, startY: point.y };
  });
  ipcMain.on('pet:drag-move', (_event, point: { x: number; y: number }) => {
    if (win === null || dragOrigin === null) return;
    win.setPosition(
      Math.round(dragOrigin.baseX + point.x - dragOrigin.startX),
      Math.round(dragOrigin.baseY + point.y - dragOrigin.startY),
    );
  });
  ipcMain.on('pet:drag-end', () => {
    dragOrigin = null;
    persistPosition();
  });

  // Right-click "设置": open (or focus) the settings window. It is a regular
  // framed window — unlike the transparent pet, it takes focus normally.
  ipcMain.on('pet:open-settings', () => {
    openSettingsWindow(settingsFile);
  });

  // Settings window edits: forward to the pet renderer immediately (smooth
  // live preview), persist to settings.json debounced (the size slider fires
  // continuously while dragged).
  let settingsWriteTimer: NodeJS.Timeout | undefined;
  ipcMain.on(
    'pet:update-settings',
    (_event, payload: { scale?: number; bubbleFontSize?: number }) => {
      if (typeof payload.scale === 'number') {
        petSettings = { ...petSettings, scale: clampPetScale(payload.scale) };
      }
      if (typeof payload.bubbleFontSize === 'number') {
        petSettings = {
          ...petSettings,
          bubbleFontSize: clampPetBubbleFontSize(payload.bubbleFontSize),
        };
      }
      if (win !== null && !win.isDestroyed()) {
        win.webContents.send('pet:settings', petSettings);
      }
      clearTimeout(settingsWriteTimer);
      settingsWriteTimer = setTimeout(() => {
        writePetSettings(petSettings);
      }, 300);
    },
  );

  // Resize requests from the renderer: the window hugs its content. Growing
  // keeps the mascot's bottom-center anchored so the pet stays put while the
  // bubble expands above it.
  ipcMain.on('pet:resize', (_event, requested: { width?: number; height?: number }) => {
    if (win === null) return;
    const scale = petSettings.scale;
    const maxWidth =
      Math.max(
        WINDOW_MIN_WIDTH,
        petSettings.bubbleFontSize * (BUBBLE_TITLE_MAX_CHARS + 1) + BUBBLE_WIDTH_CHROME,
      ) * scale;
    const width = Math.round(
      Math.min(
        Math.max(requested.width ?? WINDOW_MIN_WIDTH, WINDOW_MIN_WIDTH * scale),
        maxWidth,
      ),
    );
    const height = Math.round(
      Math.min(
        Math.max(requested.height ?? WINDOW_MIN_HEIGHT, WINDOW_MIN_HEIGHT * scale),
        WINDOW_MAX_HEIGHT * scale,
      ),
    );
    const [x, y] = win.getPosition();
    const [currentWidth, currentHeight] = win.getSize();
    if (width === currentWidth && height === currentHeight) return;
    win.setBounds({
      x: Math.round(x + currentWidth / 2 - width / 2),
      y: Math.round(y + currentHeight - height),
      width,
      height,
    });
  });

  let moveTimer: NodeJS.Timeout | undefined;
  function persistPositionDebounced(): void {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(persistPosition, 300);
  }

  const skinDataUrl = loadSkinDataUrl();
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('pet:settings', petSettings);
    if (skinDataUrl !== undefined) {
      win?.webContents.send('pet:skin', { dataUrl: skinDataUrl });
    }
  });

  setInterval(() => {
    if (win === null || win.isDestroyed()) return;
    // Send the top-ranked session's fields plus the full ranked list, so the
    // renderer can let the user page through session bubbles.
    const sessions: PetSessionSummary[] = rankSessionStates(readPetSessionStates(), Date.now()).map(
      (s) => ({
        sessionId: s.sessionId,
        status: s.status,
        statusText: s.statusText,
        title: s.title,
        pid: s.pid,
        termProgram: s.termProgram,
      }),
    );
    const top = sessions[0];
    const overlayState: PetOverlayState =
      top === undefined
        ? { status: 'idle', sessionCount: 0, sessions }
        : { ...top, sessionCount: sessions.length, sessions };
    const payload = JSON.stringify(overlayState);
    if (payload === lastPayload) return;
    lastPayload = payload;
    win.webContents.send('pet:state', overlayState);
  }, POLL_INTERVAL_MS);

  // Eye-tracking: the renderer only sees mouse events while hovered, so the
  // cursor is polled globally and relayed as window-relative coordinates.
  let lastCursor = { x: 0, y: 0 };
  setInterval(() => {
    if (win === null || win.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const [winX, winY] = win.getPosition();
    const relX = point.x - winX;
    const relY = point.y - winY;
    if (Math.abs(relX - lastCursor.x) < 2 && Math.abs(relY - lastCursor.y) < 2) return;
    lastCursor = { x: relX, y: relY };
    win.webContents.send('pet:cursor', lastCursor);
  }, CURSOR_POLL_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  app.quit();
});
