import { contextBridge, ipcRenderer, webUtils } from 'electron';

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
  /** Bilingual changelog fetched by the main process (best-effort). */
  releaseNotes?: { zh?: string; en?: string };
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
  const candidate = value as {
    state?: unknown;
    version?: unknown;
    percent?: unknown;
    message?: unknown;
    releaseDate?: unknown;
    releaseNotes?: unknown;
  };
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
  // Junk notes are dropped field-wise — never the whole status.
  if (typeof candidate.releaseNotes === 'object' && candidate.releaseNotes !== null && !Array.isArray(candidate.releaseNotes)) {
    const notes = candidate.releaseNotes as { zh?: unknown; en?: unknown };
    status.releaseNotes = {};
    if (typeof notes.zh === 'string') {
      status.releaseNotes.zh = notes.zh;
    }
    if (typeof notes.en === 'string') {
      status.releaseNotes.en = notes.en;
    }
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

/** One recent workspace shown in the Windows Jump List (main/jump-list.ts). */
export type JumpListWorkspace = { name: string; root: string };

function asJumpListWorkspaces(value: unknown): value is JumpListWorkspace[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { root?: unknown }).root === 'string' &&
        (item as { root: string }).root !== '',
    )
  );
}

/** Launch intent forwarded main → renderer (Jump List item, second-instance
    argv; main/ipc-channels.ts LaunchActionPayload, structurally duplicated). */
export type LaunchActionPayload = { action: 'new-chat' } | { action: 'open-workspace'; root: string };

function asLaunchActionPayload(value: unknown): LaunchActionPayload | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { action?: unknown; root?: unknown };
  if (candidate.action === 'new-chat') {
    return { action: 'new-chat' };
  }
  if (candidate.action === 'open-workspace' && typeof candidate.root === 'string' && candidate.root !== '') {
    return { action: 'open-workspace', root: candidate.root };
  }
  return null;
}

/** A terminal the main process spawned (main/terminal.ts NativeTerminalInfo,
    structurally duplicated). */
export type NativeTerminalInfo = { id: string; shell: string; cwd: string };

export type NativeTerminalCreateOptions = { cwd?: string; cols?: number; rows?: number };

/** PR preview state mirror (main/pr-preview.ts, dev-only). */
export type PrPreviewState = {
  phase: 'idle' | 'fetching' | 'installing' | 'building' | 'active' | 'error';
  pr?: number;
  message?: string;
  /** Live output tail of the in-flight stage (throttled pushes). */
  logTail?: string;
  /** PR whose build the window is actually serving right now, independent of
   *  the display phase (a failed rebuild keeps the previous preview serving). */
  servingPr?: number;
  /** Stage a stage failure came from, for the dialog's localized stage line. */
  errorStage?: 'fetch' | 'install' | 'build';
  /** The stage was killed by the no-output watchdog (not a plain failure). */
  errorHung?: boolean;
};

function asPrPreviewState(value: unknown): PrPreviewState | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as {
    phase?: unknown;
    pr?: unknown;
    message?: unknown;
    logTail?: unknown;
    servingPr?: unknown;
    errorStage?: unknown;
    errorHung?: unknown;
  };
  switch (candidate.phase) {
    case 'idle':
    case 'fetching':
    case 'installing':
    case 'building':
    case 'active':
    case 'error':
      break;
    default:
      return null;
  }
  const state: PrPreviewState = { phase: candidate.phase };
  if (typeof candidate.pr === 'number' && Number.isInteger(candidate.pr)) state.pr = candidate.pr;
  if (typeof candidate.message === 'string') state.message = candidate.message;
  if (typeof candidate.logTail === 'string') state.logTail = candidate.logTail;
  if (typeof candidate.servingPr === 'number' && Number.isInteger(candidate.servingPr)) {
    state.servingPr = candidate.servingPr;
  }
  if (
    candidate.errorStage === 'fetch' ||
    candidate.errorStage === 'install' ||
    candidate.errorStage === 'build'
  ) {
    state.errorStage = candidate.errorStage;
  }
  if (candidate.errorHung === true) state.errorHung = true;
  return state;
}

function asNativeTerminalInfo(value: unknown): NativeTerminalInfo | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { id?: unknown; shell?: unknown; cwd?: unknown };
  if (
    typeof candidate.id === 'string' &&
    candidate.id !== '' &&
    typeof candidate.shell === 'string' &&
    typeof candidate.cwd === 'string'
  ) {
    return { id: candidate.id, shell: candidate.shell, cwd: candidate.cwd };
  }
  return null;
}

export type KimiDesktopApi = {
  setTheme: (scheme: 'light' | 'dark' | 'system') => void;
  popupWindowsMenu: (request: {
    id: 'file' | 'edit' | 'view' | 'help';
    x: number;
    y: number;
  }) => Promise<{ opened: boolean }>;
  /** Dock tile preference ('light'|'dark'); the main process swaps the
   *  Dock icon (src/main/dock-icon.ts). macOS-only effect. */
  setDockIconChoice: (choice: 'light' | 'dark') => void;
  onMenuAction: (cb: (id: string) => void) => () => void;
  onShortcut: (cb: (accel: string) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  /** Forward a renderer-collected server token to the main process so the
   *  region probe (update feed / Help links) authenticates the same way the
   *  renderer's API client does. Fire-and-forget. */
  updateServerCredential: (token: string) => Promise<void>;
  showOpenDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
  /** Absolute filesystem path of a File the user dragged into the window.
   *  `webUtils.getPathForFile` is the only supported way to recover a path in
   *  the sandboxed renderer (File.path was removed in Electron 32). Returns
   *  null for drops with no file backing (e.g. content dragged out of a web
   *  page) or any failure — callers treat null as "not a local file". */
  getPathForFile: (file: File) => string | null;
  listOpenInApps: () => Promise<OpenInApp[]>;
  openInApp: (appId: string, path: string) => Promise<OpenInResult>;
  /** Fire-and-forget: persist "onboarding completed" in the main process's
   *  ui-state.json (survives dev-server port shifts; no-op semantics on web). */
  setOnboarded: () => void;
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
  /** Background-download preference (persisted by the main process in
   *  ui-state.json; default false — opt-in). */
  getUpdateAutoDownload: () => Promise<boolean>;
  setUpdateAutoDownload: (enabled: boolean) => Promise<void>;
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
  /** Push the renderer's customizable bindings (canonical keymap format,
   *  action id → binding | null) so the matching native menu items show them
   *  as accelerators. */
  setMenuShortcuts: (bindings: Record<string, string | null>) => void;
  /** Silence (true) or restore (false) all native menu accelerators while
   *  the settings panel records a shortcut. */
  setMenuSuspended: (suspended: boolean) => void;
  /** xterm focus in the native terminal: strip native menu accelerators so
   *  control keys (Ctrl+C & friends) reach the PTY instead of the menu. */
  setTerminalMenuFocus: (focused: boolean) => void;
  /** Push the summon-app binding (canonical keymap format) so the main
   *  process registers it as an OS-level global shortcut. Resolves false
   *  when the OS refused the binding (already taken) — the previous working
   *  shortcut stays live. */
  setGlobalShortcut: (action: string, binding: string | null) => Promise<boolean>;
  /** Unregister (true) or restore (false) the summon-app global shortcut
   *  while the settings panel records a shortcut — the OS would otherwise
   *  consume the current combo before the recorder sees it. Resuming
   *  resolves false when the OS refused the new binding (the previous
   *  working shortcut was restored), so the panel can roll back. */
  setGlobalShortcutSuspended: (suspended: boolean) => Promise<boolean>;
  /** Bring the native window back on screen (notification clicks): with
   *  hide-on-close it may be alive but hidden, and the renderer's own
   *  window.focus() can't un-hide it. */
  showWindow: () => void;
  /** Push the recent workspace list for the Windows Jump List (taskbar
   *  right-click menu). No-op semantics elsewhere (main/jump-list.ts). */
  setJumpList: (workspaces: JumpListWorkspace[]) => void;
  /** Main → renderer push of a launch intent (Jump List item click or
   *  second-instance argv: open a draft / open a workspace by root). */
  onLaunchAction: (cb: (payload: LaunchActionPayload) => void) => () => void;
  /** Main → renderer push when a whitelisted auth deep link arrives (the
   *  OAuth completion page re-opened the app): the waiting login flow polls
   *  the daemon immediately instead of finishing out the current interval.
   *  Payload-free wake signal. */
  onDeepLinkAuth: (cb: () => void) => () => void;
  /** macOS frosted-sidebar material toggle (settings → appearance). Persisted
   *  main-side so window creation applies it before the renderer boots. */
  setVibrancy: (enabled: boolean) => void;
  /** Current vibrancy preference. Default ON — only an explicit false from
   *  the main process disables. */
  getVibrancy: () => Promise<boolean>;
  /** Forward a diagnostic line to the main-process log file (fire-and-forget;
   *  the sandboxed renderer has no fs access). The main process re-validates,
   *  redacts and rate-limits everything. */
  log: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
  /** Emit a telemetry event through the main process's cloud pipeline. The
   *  event whitelist is enforced main-side; no-op until telemetry is wired
   *  (consent off / external-server mode). */
  track: (event: string, properties?: Record<string, unknown>) => void;
  /** Native embedded terminal (desktop-only): spawn a PTY in the main process
   *  (shell resolved main-side; the renderer only picks cwd/size). Output and
   *  exit stream back via onNativeTerminalOutput/onNativeTerminalExit. */
  createNativeTerminal: (opts?: NativeTerminalCreateOptions) => Promise<NativeTerminalInfo>;
  nativeTerminalInput: (id: string, data: string) => void;
  nativeTerminalResize: (id: string, cols: number, rows: number) => void;
  closeNativeTerminal: (id: string) => void;
  onNativeTerminalOutput: (cb: (id: string, data: string) => void) => () => void;
  onNativeTerminalExit: (cb: (id: string, exitCode: number | null) => void) => () => void;
  /** PR preview (dev-only): build a code-app PR's renderer in an isolated
   *  worktree and swap the window onto it. getPrPreviewState resolves null in
   *  packaged builds — the renderer hides the entry point on that signal.
   *  Transitions stream via onPrPreviewEvent. */
  getPrPreviewState: () => Promise<PrPreviewState | null>;
  prPreviewStart: (pr: number) => Promise<PrPreviewState>;
  prPreviewStop: () => Promise<PrPreviewState>;
  prPreviewCancel: () => Promise<PrPreviewState>;
  /** Manual cache reclaim: removes every preview worktree except the
   *  served/in-flight ones. Resolves with the number of removed dirs. */
  prPreviewCleanup: () => Promise<number>;
  onPrPreviewEvent: (cb: (state: PrPreviewState) => void) => () => void;
};

export const api: KimiDesktopApi = {
  setTheme: (scheme) => {
    if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
      ipcRenderer.send('kimi:theme', scheme);
    }
  },
  popupWindowsMenu: (request) => ipcRenderer.invoke('kimi:menu-popup', request),
  setDockIconChoice: (choice) => {
    if (choice === 'light' || choice === 'dark') {
      ipcRenderer.send('kimi:dock-icon-choice', choice);
    }
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
  updateServerCredential: (token) => ipcRenderer.invoke('kimi:server-credential', token),
  showOpenDialog: (opts) => ipcRenderer.invoke('kimi:dialog-open', opts),
  showSaveDialog: (opts) => ipcRenderer.invoke('kimi:dialog-save', opts),
  getPathForFile: (file) => {
    try {
      const path = webUtils.getPathForFile(file);
      return path === '' ? null : path;
    } catch {
      return null;
    }
  },
  listOpenInApps: () => ipcRenderer.invoke('kimi:open-in-list'),
  openInApp: (appId, path) => ipcRenderer.invoke('kimi:open-in', appId, path),
  setOnboarded: () => ipcRenderer.send('kimi:set-onboarded'),
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
  getUpdateAutoDownload: async () => {
    const enabled: unknown = await ipcRenderer.invoke('kimi:update-get-auto-download');
    // Anything but an explicit true reads as disabled (the main-side default).
    return enabled === true;
  },
  setUpdateAutoDownload: async (enabled) => {
    if (typeof enabled !== 'boolean') {
      return;
    }
    await ipcRenderer.invoke('kimi:update-set-auto-download', enabled);
  },
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
  setMenuShortcuts: (bindings) => {
    if (bindings !== null && typeof bindings === 'object' && !Array.isArray(bindings)) {
      ipcRenderer.send('kimi:menu-shortcut', bindings);
    }
  },
  setMenuSuspended: (suspended) => {
    if (typeof suspended === 'boolean') {
      ipcRenderer.send('kimi:menu-suspend', suspended);
    }
  },
  setTerminalMenuFocus: (focused) => {
    if (typeof focused === 'boolean') {
      ipcRenderer.send('kimi:menu-terminal-focus', focused);
    }
  },
  setGlobalShortcut: async (action, binding) => {
    if (typeof action !== 'string' || (binding !== null && typeof binding !== 'string')) {
      return false;
    }
    const result: unknown = await ipcRenderer.invoke('kimi:global-shortcut', { action, binding });
    return result === true;
  },
  setGlobalShortcutSuspended: async (suspended) => {
    if (typeof suspended !== 'boolean') {
      return false;
    }
    const result: unknown = await ipcRenderer.invoke('kimi:global-shortcut-suspend', suspended);
    return result === true;
  },
  showWindow: () => {
    ipcRenderer.send('kimi:show-window');
  },
  setJumpList: (workspaces) => {
    if (asJumpListWorkspaces(workspaces)) {
      ipcRenderer.send('kimi:jump-list', workspaces);
    }
  },
  onLaunchAction: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const action = asLaunchActionPayload(payload);
      if (action !== null) {
        cb(action);
      }
    };
    ipcRenderer.on('kimi:launch-action', listener);
    return () => ipcRenderer.removeListener('kimi:launch-action', listener);
  },
  onDeepLinkAuth: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('kimi:deep-link-auth', listener);
    return () => ipcRenderer.removeListener('kimi:deep-link-auth', listener);
  },
  setVibrancy: (enabled) => {
    if (typeof enabled === 'boolean') {
      ipcRenderer.send('kimi:vibrancy', enabled);
    }
  },
  getVibrancy: async () => (await ipcRenderer.invoke('kimi:get-vibrancy')) !== false,
  log: (level, message, detail) => {
    if (level !== 'info' && level !== 'warn' && level !== 'error') return;
    if (typeof message !== 'string' || message === '') return;
    ipcRenderer.send('kimi:renderer-log', { level, message, detail });
  },
  track: (event, properties) => {
    if (typeof event === 'string' && event !== '') {
      ipcRenderer.send('kimi:track', event, properties);
    }
  },
  createNativeTerminal: async (opts) => {
    const options: Record<string, unknown> = {};
    if (typeof opts?.cwd === 'string' && opts.cwd !== '') options['cwd'] = opts.cwd;
    if (typeof opts?.cols === 'number' && Number.isFinite(opts.cols)) options['cols'] = opts.cols;
    if (typeof opts?.rows === 'number' && Number.isFinite(opts.rows)) options['rows'] = opts.rows;
    const info = asNativeTerminalInfo(await ipcRenderer.invoke('kimi:terminal-create', options));
    if (info === null) {
      throw new Error('terminal-create: invalid response from main process');
    }
    return info;
  },
  nativeTerminalInput: (id, data) => {
    if (typeof id === 'string' && id !== '' && typeof data === 'string' && data !== '') {
      ipcRenderer.send('kimi:terminal-input', { id, data });
    }
  },
  nativeTerminalResize: (id, cols, rows) => {
    if (
      typeof id === 'string' &&
      id !== '' &&
      typeof cols === 'number' &&
      Number.isFinite(cols) &&
      typeof rows === 'number' &&
      Number.isFinite(rows)
    ) {
      ipcRenderer.send('kimi:terminal-resize', { id, cols, rows });
    }
  },
  closeNativeTerminal: (id) => {
    if (typeof id === 'string' && id !== '') {
      ipcRenderer.send('kimi:terminal-close', { id });
    }
  },
  onNativeTerminalOutput: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return;
      const { id, data } = payload as { id?: unknown; data?: unknown };
      if (typeof id === 'string' && id !== '' && typeof data === 'string') {
        cb(id, data);
      }
    };
    ipcRenderer.on('kimi:terminal-output', listener);
    return () => ipcRenderer.removeListener('kimi:terminal-output', listener);
  },
  onNativeTerminalExit: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return;
      const { id, exitCode } = payload as { id?: unknown; exitCode?: unknown };
      if (typeof id === 'string' && id !== '') {
        cb(id, typeof exitCode === 'number' ? exitCode : null);
      }
    };
    ipcRenderer.on('kimi:terminal-exit', listener);
    return () => ipcRenderer.removeListener('kimi:terminal-exit', listener);
  },
  getPrPreviewState: async () => asPrPreviewState(await ipcRenderer.invoke('kimi:pr-preview-get-state')),
  prPreviewStart: async (pr) => {
    if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1 || pr > 999999) {
      throw new Error('pr-preview-start: invalid PR number');
    }
    const state = asPrPreviewState(await ipcRenderer.invoke('kimi:pr-preview-start', pr));
    if (state === null) {
      throw new Error('pr-preview-start: invalid response from main process');
    }
    return state;
  },
  prPreviewStop: async () => {
    const state = asPrPreviewState(await ipcRenderer.invoke('kimi:pr-preview-stop'));
    if (state === null) {
      throw new Error('pr-preview-stop: invalid response from main process');
    }
    return state;
  },
  prPreviewCancel: async () => {
    const state = asPrPreviewState(await ipcRenderer.invoke('kimi:pr-preview-cancel'));
    if (state === null) {
      throw new Error('pr-preview-cancel: invalid response from main process');
    }
    return state;
  },
  prPreviewCleanup: async () => {
    const removed: unknown = await ipcRenderer.invoke('kimi:pr-preview-cleanup');
    return typeof removed === 'number' && Number.isInteger(removed) && removed >= 0 ? removed : 0;
  },
  onPrPreviewEvent: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const state = asPrPreviewState(payload);
      if (state !== null) {
        cb(state);
      }
    };
    ipcRenderer.on('kimi:pr-preview-event', listener);
    return () => ipcRenderer.removeListener('kimi:pr-preview-event', listener);
  },
};

contextBridge.exposeInMainWorld('kimiDesktop', api);
