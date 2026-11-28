import { ipcRenderer, webUtils } from 'electron';
import { isSleepPreventionMode, type PreventSleepState, type SleepPreventionMode } from '../../../shared/prevent-sleep';
import { isDesktopFailureKind, type DesktopFailureKind } from '../../../shared/failure-feedback';
import {
  isTerminalActivityList,
  normalizeTerminalSshTarget,
  type NativeTerminalBridge,
  type NativeTerminalCreateOptions,
  type NativeTerminalSshTarget,
  type TerminalActivity,
} from '../../../shared/terminal-activity';
import type { ScreenshotGuidance, ScreenshotGuidanceAction } from '../../../shared/screenshot-guidance';
import type { ProviderModelsFetchResult } from '../../system/provider-models-fetch';
import type { FeedbackDiagnosticsArchive } from '../../../shared/feedback-diagnostics';

export type DialogOptions = Record<string, unknown>;

export type OpenInApp = { id: string; label: string; preferred?: boolean };
export type OpenInResult = { ok: boolean; error?: string };

function asPreventSleepState(value: unknown): PreventSleepState {
  if (typeof value !== 'object' || value === null) {
    return { system: 'allow-sleep', lid: false, lidSupported: false };
  }
  const candidate = value as { system?: unknown; lid?: unknown; lidSupported?: unknown; lidNeedsRepair?: unknown };
  return {
    system: isSleepPreventionMode(candidate.system) ? candidate.system : 'allow-sleep',
    lid: candidate.lid === true,
    lidSupported: candidate.lidSupported === true,
    ...(candidate.lidNeedsRepair === true ? { lidNeedsRepair: true } : {}),
  };
}

function asProviderModelsFetchResult(value: unknown): ProviderModelsFetchResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { ok?: unknown; status?: unknown; body?: unknown; kind?: unknown };
  if (candidate.ok === true) {
    if (typeof candidate.status !== 'number' || !Number.isInteger(candidate.status)) {
      return null;
    }
    if (typeof candidate.body !== 'string') {
      return null;
    }
    return { ok: true, status: candidate.status, body: candidate.body };
  }
  if (candidate.ok === false && (candidate.kind === 'timeout' || candidate.kind === 'network')) {
    return { ok: false, kind: candidate.kind };
  }
  return null;
}

export type NativeTerminalInfo = { id: string; shell: string; cwd: string };
export type { NativeTerminalCreateOptions, NativeTerminalSshTarget };

export type ScreenshotCaptureResult =
  | { status: 'ok'; pngBytes: Uint8Array; comment: string; captureId: string }
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'denied' }
  | { status: 'error'; reason: string; captureId?: string };

function asScreenshotCaptureResult(value: unknown): ScreenshotCaptureResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { status?: unknown; pngBytes?: unknown; comment?: unknown; reason?: unknown; captureId?: unknown };
  switch (candidate.status) {
    case 'ok':
      if (!(candidate.pngBytes instanceof Uint8Array) || typeof candidate.comment !== 'string') return null;
      return {
        status: 'ok',
        pngBytes: candidate.pngBytes,
        comment: candidate.comment,
        captureId: typeof candidate.captureId === 'string' ? candidate.captureId : '',
      };
    case 'completed':
    case 'cancelled':
    case 'denied':
      return { status: candidate.status };
    case 'error':
      return {
        status: 'error',
        reason: typeof candidate.reason === 'string' ? candidate.reason : 'unknown',
        captureId: typeof candidate.captureId === 'string' ? candidate.captureId : undefined,
      };
    default:
      return null;
  }
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

export type SystemBridge = Omit<NativeTerminalBridge, 'inspectNativeTerminals'> & {
  inspectNativeTerminals: (ids: string[]) => Promise<TerminalActivity[]>;
  openExternal: (url: string) => Promise<void>;
  writeClipboardText: (text: string) => Promise<boolean>;
  collectFeedbackDiagnostics: () => Promise<FeedbackDiagnosticsArchive>;
  onFailureToast: (cb: (kind: DesktopFailureKind, url?: string) => void) => () => void;
  updateServerCredential: (token: string) => Promise<void>;
  showOpenDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
  getPathForFile: (file: File) => string | null;
  listOpenInApps: (filePath?: string) => Promise<OpenInApp[]>;
  openInApp: (appId: string, path: string) => Promise<OpenInResult>;
  setPreventSystemSleep: (mode: SleepPreventionMode) => Promise<PreventSleepState>;
  getPreventSystemSleep: () => Promise<boolean>;
  getPreventSleepState: () => Promise<PreventSleepState>;
  setPreventLidSleep: (enabled: boolean) => Promise<PreventSleepState>;
  log: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
  reportStartupMilestone: (milestone: 'ui-mounted' | 'ui-ready' | 'boot-stage', stage?: string) => void;
  track: (event: string, properties?: Record<string, unknown>) => void;
  isScreenshotSupported: () => boolean;
  captureScreenshot: () => Promise<ScreenshotCaptureResult>;
  getScreenshotGuidance: () => Promise<ScreenshotGuidance | null>;
  onScreenshotGuidance: (cb: (guide: ScreenshotGuidance | null) => void) => () => void;
  screenshotGuidanceAction: (captureId: string, action: ScreenshotGuidanceAction) => Promise<void>;
  cancelScreenshotCapture: () => void;
  onScreenshotHotkey: (cb: () => void) => () => void;
  onScreenshotHotkeyResult: (cb: (result: ScreenshotCaptureResult) => void) => () => void;
  fetchProviderModels: (request: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }) => Promise<ProviderModelsFetchResult | null>;
};

export const systemBridge: SystemBridge = {
  inspectNativeTerminals: async ids => {
    const result: unknown = await ipcRenderer.invoke('kimi:terminal-inspect', ids);
    if (!isTerminalActivityList(result)) throw new Error('Invalid terminal activity response');
    return result;
  },
  openExternal: (url) => ipcRenderer.invoke('kimi:open-external', url),
  writeClipboardText: (text) => ipcRenderer.invoke('kimi:write-clipboard-text', text),
  collectFeedbackDiagnostics: () => ipcRenderer.invoke('kimi:feedback-diagnostics-collect'),
  onFailureToast: (cb) => {
    const listener = (_event: unknown, kind: unknown, url: unknown) => {
      if (!isDesktopFailureKind(kind)) return;
      const copyUrl = typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://')) ? url : undefined;
      cb(kind, copyUrl);
    };
    ipcRenderer.on('kimi:failure-toast', listener);
    return () => ipcRenderer.removeListener('kimi:failure-toast', listener);
  },
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
  listOpenInApps: (filePath) => ipcRenderer.invoke('kimi:open-in-list', filePath),
  openInApp: (appId, path) => ipcRenderer.invoke('kimi:open-in', appId, path),
  setPreventSystemSleep: async (mode) => {
    if (!isSleepPreventionMode(mode)) return { system: 'allow-sleep', lid: false, lidSupported: false };
    return ipcRenderer.invoke('kimi:prevent-system-sleep', mode).then(asPreventSleepState);
  },
  getPreventSystemSleep: async () => (await ipcRenderer.invoke('kimi:get-prevent-system-sleep')) === true,
  getPreventSleepState: async () => asPreventSleepState(await ipcRenderer.invoke('kimi:prevent-sleep-state')),
  setPreventLidSleep: async (enabled) => {
    if (typeof enabled !== 'boolean') return { system: 'allow-sleep', lid: false, lidSupported: false };
    return ipcRenderer.invoke('kimi:set-prevent-lid-sleep', enabled).then(asPreventSleepState);
  },
  log: (level, message, detail) => {
    if (level !== 'info' && level !== 'warn' && level !== 'error') return;
    if (typeof message !== 'string' || message === '') return;
    ipcRenderer.send('kimi:renderer-log', { level, message, detail });
  },
  reportStartupMilestone: (milestone, stage) => {
    if (milestone !== 'ui-mounted' && milestone !== 'ui-ready' && milestone !== 'boot-stage') return;
    if (milestone === 'boot-stage') {
      if (typeof stage === 'string' && stage !== '') ipcRenderer.send('kimi:startup-milestone', { milestone, stage });
      return;
    }
    ipcRenderer.send('kimi:startup-milestone', { milestone });
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
    const ssh = normalizeTerminalSshTarget(opts?.ssh);
    if (ssh !== undefined) options['ssh'] = ssh;
    const info = asNativeTerminalInfo(await ipcRenderer.invoke('kimi:terminal-create', options));
    if (info === null) {
      throw new Error('terminal-create: invalid response from main process');
    }
    return info;
  },
  isScreenshotSupported: () => process.platform !== 'linux'
    || process.env['XDG_SESSION_TYPE']?.toLowerCase() === 'x11'
    || process.env['WAYLAND_DISPLAY'] === undefined,
  captureScreenshot: async () => {
    const result = asScreenshotCaptureResult(await ipcRenderer.invoke('kimi:screenshot-capture'));
    return result ?? { status: 'error', reason: 'invalid screenshot-capture response' };
  },
  cancelScreenshotCapture: () => {
    ipcRenderer.send('kimi:screenshot-cancel');
  },
  getScreenshotGuidance: () => ipcRenderer.invoke('kimi:screenshot-guide-get'),
  onScreenshotGuidance: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, guide: ScreenshotGuidance | null) => cb(guide);
    ipcRenderer.on('kimi:screenshot-guide-changed', listener);
    return () => ipcRenderer.removeListener('kimi:screenshot-guide-changed', listener);
  },
  screenshotGuidanceAction: (captureId, action) => ipcRenderer.invoke('kimi:screenshot-guide-action', captureId, action),
  onScreenshotHotkey: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('kimi:screenshot-hotkey', listener);
    return () => ipcRenderer.removeListener('kimi:screenshot-hotkey', listener);
  },
  onScreenshotHotkeyResult: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, result: ScreenshotCaptureResult) => cb(result);
    ipcRenderer.on('kimi:screenshot-hotkey-result', listener);
    return () => ipcRenderer.removeListener('kimi:screenshot-hotkey-result', listener);
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
  fetchProviderModels: async (request) => {
    const result = asProviderModelsFetchResult(
      await ipcRenderer.invoke('kimi:provider-models-fetch', request),
    );
    return result;
  },
};
