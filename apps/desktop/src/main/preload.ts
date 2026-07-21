import { contextBridge, ipcRenderer } from 'electron';

// Renderer-facing surface of the `window.kimiDesktop` bridge. Keep this a tight
// whitelist: every native capability is exposed as an explicit method. NEVER
// expose `ipcRenderer`, `node`, or `require` — the renderer is sandboxed with
// contextIsolation and must reach the main process only through these methods.
export type DialogOptions = Record<string, unknown>;

/** One installed editor/terminal the workspace can be opened in (open-in.ts). */
export type OpenInApp = { id: string; label: string };
export type OpenInResult = { ok: boolean; error?: string };

// Mirror of the main-process UpdateStatus (updater.ts). Duplicated
// structurally — the preload has its own literal surface by design (see the
// header comment of ipc-channels.ts).
export type UpdateStatus = {
  state: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
};

const UPDATE_STATES = new Set(['idle', 'available', 'downloading', 'downloaded', 'error']);

/** Outcome of a manual "check for updates" (main/updater.ts UpdateCheckResult,
    structurally duplicated — preload keeps its own literal surface). */
export type UpdateCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  | { outcome: 'unsupported' }
  | { outcome: 'error'; message: string };

const UPDATE_CHECK_OUTCOMES = new Set(['available', 'latest', 'unsupported', 'error']);

/** Pending-attention totals for the tray badge (main/tray.ts TrayAttention,
    structurally duplicated — preload keeps its own literal surface). */
export type TrayAttentionItem = {
  sessionId: string;
  title: string;
  unread: boolean;
  approvals: number;
  questions: number;
};
export type TrayAttention = {
  unread: number;
  approvals: number;
  questions: number;
  items: TrayAttentionItem[];
};

function asCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function asTrayAttentionItem(value: unknown): value is TrayAttentionItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    sessionId?: unknown;
    title?: unknown;
    unread?: unknown;
    approvals?: unknown;
    questions?: unknown;
  };
  return (
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId !== '' &&
    typeof candidate.title === 'string' &&
    typeof candidate.unread === 'boolean' &&
    asCount(candidate.approvals) &&
    asCount(candidate.questions)
  );
}

function asTrayAttention(value: unknown): value is TrayAttention {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    unread?: unknown;
    approvals?: unknown;
    questions?: unknown;
    items?: unknown;
  };
  return (
    asCount(candidate.unread) &&
    asCount(candidate.approvals) &&
    asCount(candidate.questions) &&
    Array.isArray(candidate.items) &&
    candidate.items.every(asTrayAttentionItem)
  );
}

function asUpdateStatus(value: unknown): UpdateStatus | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { state?: unknown; version?: unknown; percent?: unknown; message?: unknown; releaseDate?: unknown };
  if (typeof candidate.state !== 'string' || !UPDATE_STATES.has(candidate.state)) {
    return null;
  }
  const status: UpdateStatus = { state: candidate.state as UpdateStatus['state'] };
  if (typeof candidate.version === 'string') {
    status.version = candidate.version;
  }
  if (typeof candidate.percent === 'number') {
    status.percent = candidate.percent;
  }
  if (typeof candidate.message === 'string') {
    status.message = candidate.message;
  }
  if (typeof candidate.releaseDate === 'string') {
    status.releaseDate = candidate.releaseDate;
  }
  return status;
}

function asUpdateCheckResult(value: unknown): UpdateCheckResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { outcome?: unknown; version?: unknown; message?: unknown };
  if (typeof candidate.outcome !== 'string' || !UPDATE_CHECK_OUTCOMES.has(candidate.outcome)) {
    return null;
  }
  switch (candidate.outcome) {
    case 'available':
      return typeof candidate.version === 'string'
        ? { outcome: 'available', version: candidate.version }
        : { outcome: 'available' };
    case 'error':
      return {
        outcome: 'error',
        message: typeof candidate.message === 'string' ? candidate.message : 'unknown error',
      };
    default:
      return { outcome: candidate.outcome as 'latest' | 'unsupported' };
  }
}

/** Pointer position in global display coordinates (pet-window drag). */
export type ScreenPoint = { screenX: number; screenY: number };

function asScreenPoint(value: unknown): value is ScreenPoint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { screenX?: unknown; screenY?: unknown };
  return (
    typeof candidate.screenX === 'number' &&
    Number.isFinite(candidate.screenX) &&
    typeof candidate.screenY === 'number' &&
    Number.isFinite(candidate.screenY)
  );
}

export type KimiDesktopApi = {
  setTheme: (scheme: 'light' | 'dark' | 'system') => void;
  onMenu: (cb: (action: string) => void) => () => void;
  onMenuAction: (cb: (id: string) => void) => () => void;
  onShortcut: (cb: (accel: string) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  showOpenDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
  listOpenInApps: () => Promise<OpenInApp[]>;
  openInApp: (appId: string, path: string) => Promise<OpenInResult>;
  getServerToken: () => Promise<string | undefined>;
  /** Current native-window fullscreen state (initial value; transitions come
   *  through `onFullscreenChanged`). */
  isFullscreen: () => Promise<boolean>;
  /** Main → renderer push on every window fullscreen enter/leave. */
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void;
  /** Current auto-update status (initial value; transitions come through
   *  `onUpdateStatus`). */
  getUpdateStatus: () => Promise<UpdateStatus>;
  /** User-initiated update check; resolves with the outcome ('unsupported'
   *  in dev / unpackaged runs). */
  checkForUpdates: () => Promise<UpdateCheckResult>;
  /** Main → renderer push on every auto-update state transition. */
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void;
  /** Start downloading the available update (user-initiated). */
  downloadUpdate: () => Promise<void>;
  /** Quit and install the downloaded update. */
  installUpdate: () => Promise<void>;
  /** Push the pending-attention totals (unread sessions + awaiting approvals +
   *  awaiting questions) and the per-session attention list so the tray can
   *  render the macOS menu-bar count and the clickable session menu
   *  (see main/tray.ts). */
  setTrayAttention: (attention: TrayAttention) => void;
  /** Main → renderer push when a tray attention entry is clicked. */
  onTraySelectSession: (cb: (sessionId: string) => void) => () => void;
  /** Sync the in-app language so native surfaces (today: the tray menu and
   *  tooltip) follow it instead of only the OS language. */
  setLocale: (locale: 'en' | 'zh') => void;
  /** Desktop-pet window drag lifecycle (pet.html only). Positions are global
   *  screen coordinates from PointerEvent.screenX/screenY; the main process
   *  moves the window keeping the offset captured at drag start. */
  petDragStart: (pos: ScreenPoint) => void;
  petDragMove: (pos: ScreenPoint) => void;
  petDragEnd: () => void;
  /** Bring the native window back on screen (notification clicks): with
   *  macOS hide-on-close it may be alive but hidden, and the renderer's own
   *  window.focus() can't un-hide it. */
  showWindow: () => void;
};

export const api: KimiDesktopApi = {
  setTheme: (scheme) => {
    if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
      ipcRenderer.send('kimi:theme', scheme);
    }
  },
  onMenu: (cb) => {
    const listener = (_event: unknown, action: string) => cb(action);
    ipcRenderer.on('kimi:menu', listener);
    return () => ipcRenderer.removeListener('kimi:menu', listener);
  },
  onMenuAction: (cb) => {
    const listener = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on('kimi:menu-action', listener);
    return () => ipcRenderer.removeListener('kimi:menu-action', listener);
  },
  onShortcut: (cb) => {
    const listener = (_event: unknown, accel: string) => cb(accel);
    ipcRenderer.on('kimi:shortcut', listener);
    return () => ipcRenderer.removeListener('kimi:shortcut', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('kimi:open-external', url),
  showOpenDialog: (opts) => ipcRenderer.invoke('kimi:dialog-open', opts),
  showSaveDialog: (opts) => ipcRenderer.invoke('kimi:dialog-save', opts),
  listOpenInApps: () => ipcRenderer.invoke('kimi:open-in-list'),
  openInApp: (appId, path) => ipcRenderer.invoke('kimi:open-in', appId, path),
  getServerToken: () => ipcRenderer.invoke('kimi:get-server-token'),
  isFullscreen: () => ipcRenderer.invoke('kimi:is-fullscreen'),
  onFullscreenChanged: (cb) => {
    const listener = (_event: unknown, flag: unknown) => cb(flag === true);
    ipcRenderer.on('kimi:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('kimi:fullscreen-changed', listener);
  },
  getUpdateStatus: async () => {
    const status = asUpdateStatus(await ipcRenderer.invoke('kimi:update-get-status'));
    return status ?? { state: 'idle' };
  },
  checkForUpdates: async () => {
    const result = asUpdateCheckResult(await ipcRenderer.invoke('kimi:update-check'));
    return result ?? { outcome: 'error', message: 'invalid update-check response' };
  },
  onUpdateStatus: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const status = asUpdateStatus(payload);
      if (status !== null) {
        cb(status);
      }
    };
    ipcRenderer.on('kimi:update-status', listener);
    return () => ipcRenderer.removeListener('kimi:update-status', listener);
  },
  downloadUpdate: () => ipcRenderer.invoke('kimi:update-download'),
  installUpdate: () => ipcRenderer.invoke('kimi:update-install'),
  setTrayAttention: (attention) => {
    if (asTrayAttention(attention)) {
      ipcRenderer.send('kimi:tray-attention', attention);
    }
  },
  onTraySelectSession: (cb) => {
    const listener = (_event: unknown, sessionId: unknown) => {
      if (typeof sessionId === 'string' && sessionId !== '') {
        cb(sessionId);
      }
    };
    ipcRenderer.on('kimi:tray-select-session', listener);
    return () => ipcRenderer.removeListener('kimi:tray-select-session', listener);
  },
  setLocale: (locale) => {
    if (locale === 'en' || locale === 'zh') {
      ipcRenderer.send('kimi:locale', locale);
    }
  },
  petDragStart: (pos) => {
    if (asScreenPoint(pos)) {
      ipcRenderer.send('kimi:pet-drag-start', pos);
    }
  },
  petDragMove: (pos) => {
    if (asScreenPoint(pos)) {
      ipcRenderer.send('kimi:pet-drag-move', pos);
    }
  },
  petDragEnd: () => {
    ipcRenderer.send('kimi:pet-drag-end');
  },
  showWindow: () => {
    ipcRenderer.send('kimi:show-window');
  },
};

contextBridge.exposeInMainWorld('kimiDesktop', api);
