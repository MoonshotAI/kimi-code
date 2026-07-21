import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { BrowserWindowConstructorOptions, IpcMainEvent, Rectangle } from 'electron';

import { IPC } from './ipc-channels';
import { RENDERER_HOST, RENDERER_SCHEME, rendererDevBase } from './protocol';
import { log } from './log';

// Desktop pet (小蓝): a small transparent always-on-top window showing the
// brand mascot with idle animations. macOS only for now (app.ts gates the
// call); created once at startup, lives until the app quits. The pet page
// (`renderer/pet.html`) is self-contained — no server connection — so this
// module only owns the window, the drag channel, and position persistence.

export const PET_SIZE = { width: 208, height: 180 } as const;

// Gap between the pet and the primary display's bottom-right corner on first
// run (before any dragged position has been persisted).
const DEFAULT_MARGIN = { x: 40, y: 24 } as const;

export interface PetPosition {
  x: number;
  y: number;
}

/** Pointer position in global display coordinates (PointerEvent.screenX/Y). */
export interface ScreenPoint {
  screenX: number;
  screenY: number;
}

export function petWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Floating above other windows, but never stealing keyboard focus. Mouse
    // events are still delivered to a non-focusable window on macOS, which is
    // all the pet needs (drag + click).
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

/** Bottom-right of the given work area, honouring the default margin. */
export function initialPetPosition(workArea: Rectangle): PetPosition {
  return {
    x: workArea.x + workArea.width - PET_SIZE.width - DEFAULT_MARGIN.x,
    y: workArea.y + workArea.height - PET_SIZE.height - DEFAULT_MARGIN.y,
  };
}

/** Saved positions outlive the display they were taken on (external monitor
    unplugged since): accept one only when the pet window's CENTRE would land
    inside some connected display's work area — enough of the pet is then on
    screen to grab it back. Otherwise fall back to the primary corner. */
export function isPetPositionOnScreen(position: PetPosition, workAreas: Rectangle[]): boolean {
  const centreX = position.x + PET_SIZE.width / 2;
  const centreY = position.y + PET_SIZE.height / 2;
  return workAreas.some(
    (area) =>
      centreX >= area.x &&
      centreX < area.x + area.width &&
      centreY >= area.y &&
      centreY < area.y + area.height,
  );
}

/** Offset kept constant through a drag: window position − pointer position. */
export function dragOffset(windowPos: PetPosition, pointer: ScreenPoint): PetPosition {
  return { x: windowPos.x - pointer.screenX, y: windowPos.y - pointer.screenY };
}

export function asScreenPoint(value: unknown): ScreenPoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { screenX?: unknown; screenY?: unknown };
  if (
    typeof candidate.screenX === 'number' &&
    Number.isFinite(candidate.screenX) &&
    typeof candidate.screenY === 'number' &&
    Number.isFinite(candidate.screenY)
  ) {
    return { screenX: candidate.screenX, screenY: candidate.screenY };
  }
  return null;
}

/** URL of the pet page: Vite dev server in HMR dev, `app://` otherwise. No
    token/origin params — the pet never talks to the server. */
export function petUrl(devBase: string | undefined): string {
  if (devBase === undefined) {
    return `${RENDERER_SCHEME}://${RENDERER_HOST}/pet.html`;
  }
  return new URL('pet.html', devBase).toString();
}

// --- state persistence (same best-effort pattern as window-state.json) -------

function stateFile(): string {
  return join(app.getPath('userData'), 'pet-state.json');
}

/** Persisted pet state: last dragged position + tray-toggle visibility. */
export interface PetState {
  position: PetPosition | null;
  /** Defaults to true — the pet shows on first run and on pre-toggle state
      files that only carry a position. */
  visible: boolean;
}

export function loadPetState(stateFilePath: string): PetState {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as {
      x?: unknown;
      y?: unknown;
      visible?: unknown;
    };
    const position =
      typeof parsed.x === 'number' && typeof parsed.y === 'number'
        ? { x: parsed.x, y: parsed.y }
        : null;
    return { position, visible: parsed.visible !== false };
  } catch {
    // No saved state yet, or it is unreadable — corner + visible.
    return { position: null, visible: true };
  }
}

export function savePetState(stateFilePath: string, state: PetState): void {
  try {
    mkdirSync(dirname(stateFilePath), { recursive: true });
    writeFileSync(stateFilePath, JSON.stringify({ ...state.position, visible: state.visible }));
  } catch {
    // Best-effort; losing the pet's state is not worth surfacing an error.
  }
}

// --- window -------------------------------------------------------------------

// Module-scoped live instance (same pattern as window.ts's mainWindow). Only
// one pet window ever exists; it is created once at startup and merely
// hidden/shown by the tray toggle, so its Rive runtime isn't churned.
let petWindow: BrowserWindow | null = null;

export function isPetVisible(): boolean {
  return petWindow !== null && !petWindow.isDestroyed() && petWindow.isVisible();
}

/** Tray toggle: hide/show the pet window and persist the choice. Returns the
    resulting visibility (false when no pet window exists — e.g. non-macOS). */
export function togglePetVisibility(): boolean {
  if (petWindow === null || petWindow.isDestroyed()) return false;
  const visible = !petWindow.isVisible();
  if (visible) {
    petWindow.showInactive(); // show without stealing focus
  } else {
    petWindow.hide();
  }
  const position = petWindow.getPosition();
  savePetState(stateFile(), {
    position: { x: position[0] ?? 0, y: position[1] ?? 0 },
    visible,
  });
  return visible;
}

export function createPetWindow(): void {
  const file = stateFile();
  const state = loadPetState(file);
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const position =
    state.position !== null && isPetPositionOnScreen(state.position, workAreas)
      ? state.position
      : initialPetPosition(screen.getPrimaryDisplay().workArea);
  const win = new BrowserWindow({ ...petWindowOptions(), ...position, show: state.visible });
  petWindow = win;
  // Follow the user across macOS Spaces (but not into full-screen apps).
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  // Drag channel. The renderer sends pointer positions in screen coordinates;
  // the window keeps the offset captured at drag start. Handlers accept only
  // the pet's own webContents — another window's renderer must not move it.
  let offset: PetPosition | null = null;
  const fromPet = (event: IpcMainEvent): boolean => event.sender === win.webContents;

  const onDragStart = (event: IpcMainEvent, payload: unknown): void => {
    if (!fromPet(event) || win.isDestroyed()) return;
    const point = asScreenPoint(payload);
    if (point === null) return;
    const position = win.getPosition();
    offset = dragOffset({ x: position[0] ?? 0, y: position[1] ?? 0 }, point);
  };
  const onDragMove = (event: IpcMainEvent, payload: unknown): void => {
    if (!fromPet(event) || win.isDestroyed() || offset === null) return;
    const point = asScreenPoint(payload);
    if (point === null) return;
    win.setPosition(Math.round(point.screenX + offset.x), Math.round(point.screenY + offset.y));
  };
  const onDragEnd = (event: IpcMainEvent): void => {
    if (!fromPet(event) || win.isDestroyed()) return;
    offset = null;
    const raw = win.getPosition();
    let position = { x: raw[0] ?? 0, y: raw[1] ?? 0 };
    // A drag can shove the pet fully past the screen edge (or its display can
    // be unplugged mid-session); snap it back to the primary corner so it
    // stays recoverable without an app restart.
    const workAreas = screen.getAllDisplays().map((display) => display.workArea);
    if (!isPetPositionOnScreen(position, workAreas)) {
      position = initialPetPosition(screen.getPrimaryDisplay().workArea);
      win.setPosition(position.x, position.y);
    }
    // A drag implies the window is visible; keep the persisted flag in sync.
    savePetState(file, { position, visible: true });
  };

  ipcMain.on(IPC.petDragStart, onDragStart);
  ipcMain.on(IPC.petDragMove, onDragMove);
  ipcMain.on(IPC.petDragEnd, onDragEnd);
  win.on('closed', () => {
    ipcMain.removeListener(IPC.petDragStart, onDragStart);
    ipcMain.removeListener(IPC.petDragMove, onDragMove);
    ipcMain.removeListener(IPC.petDragEnd, onDragEnd);
    if (petWindow === win) {
      petWindow = null;
    }
  });

  const devBase = app.isPackaged ? undefined : rendererDevBase(process.env['KIMI_RENDERER_DEV_URL']);
  void win.loadURL(petUrl(devBase)).catch((error: unknown) => {
    log.error(`[kimi-desktop] pet window failed to load: ${String(error)}`);
  });
}
