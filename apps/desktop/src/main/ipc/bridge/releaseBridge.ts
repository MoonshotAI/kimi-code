import { ipcRenderer } from 'electron';
import {
  asRuntimeEnvironmentGetResult,
  asRuntimeEnvironmentOverrides,
  asRuntimeEnvironmentSaveResult,
  type RuntimeEnvironmentGetResult,
  type RuntimeEnvironmentOverrides,
  type RuntimeEnvironmentSaveResult,
} from '../../../shared/runtime-environment';

export type UpdateStatus = {
  state: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
  releaseNotes?: { zh?: string; en?: string };
};

const UPDATE_STATES = new Set(['idle', 'available', 'downloading', 'downloaded', 'error']);

export type UpdateCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  | { outcome: 'unsupported' }
  | { outcome: 'error'; message: string };

const UPDATE_CHECK_OUTCOMES = new Set(['available', 'latest', 'unsupported', 'error']);

export type CanaryInfo = { enabled: boolean; isCanaryBuild: boolean; isRealCanaryBuild: boolean };

export type CanaryStableImportResult = {
  status: 'relaunching' | 'unavailable' | 'no-stable-data' | 'stable-running' | 'error' | 'cancelled';
  error?: string;
};

const CANARY_STABLE_IMPORT_STATUSES = new Set(['relaunching', 'unavailable', 'no-stable-data', 'stable-running', 'error', 'cancelled']);

function asCanaryStableImportResult(value: unknown): CanaryStableImportResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { status?: unknown; error?: unknown };
  if (typeof candidate.status !== 'string' || !CANARY_STABLE_IMPORT_STATUSES.has(candidate.status)) {
    return null;
  }
  return {
    status: candidate.status as CanaryStableImportResult['status'],
    ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}),
  };
}

function asCanaryInfo(value: unknown): CanaryInfo | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as {
    enabled?: unknown;
    isCanaryBuild?: unknown;
    isRealCanaryBuild?: unknown;
  };
  if (typeof candidate.enabled !== 'boolean' || typeof candidate.isCanaryBuild !== 'boolean') {
    return null;
  }
  return {
    enabled: candidate.enabled,
    isCanaryBuild: candidate.isCanaryBuild,
    isRealCanaryBuild: candidate.isRealCanaryBuild === true,
  };
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

export type ReleaseBridge = {
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  getUpdateAutoDownload: () => Promise<boolean>;
  setUpdateAutoDownload: (enabled: boolean) => Promise<void>;
  getRemoteControlRestoreState: () => Promise<{ restoreEnabled: boolean; previousEnabled: boolean }>;
  setRemoteControlRestoreState: (patch: { restoreEnabled?: boolean; previousEnabled?: boolean }) => Promise<void>;
  onRemoteControlRestoreFinished: (cb: () => void) => () => void;
  getCanaryInfo: () => Promise<CanaryInfo>;
  canaryImportStableSettings?: () => Promise<CanaryStableImportResult>;
  getRuntimeEnvironmentOverrides: () => Promise<RuntimeEnvironmentGetResult>;
  saveRuntimeEnvironmentOverrides: (overrides: RuntimeEnvironmentOverrides) => Promise<RuntimeEnvironmentSaveResult>;
  resetRuntimeEnvironmentOverrides: () => Promise<RuntimeEnvironmentSaveResult>;
};

export const releaseBridge: ReleaseBridge = {
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
    return enabled === true;
  },
  setUpdateAutoDownload: async (enabled) => {
    if (typeof enabled !== 'boolean') {
      return;
    }
    await ipcRenderer.invoke('kimi:update-set-auto-download', enabled);
  },
  getRemoteControlRestoreState: async () => {
    const state = (await ipcRenderer.invoke('kimi:remote-control-restore-state-get')) as {
      restoreEnabled?: unknown;
      previousEnabled?: unknown;
    } | null;
    return {
      restoreEnabled: state?.restoreEnabled === true,
      previousEnabled: state?.previousEnabled === true,
    };
  },
  setRemoteControlRestoreState: async (patch) => {
    const value: Record<string, boolean> = {};
    if (typeof patch.restoreEnabled === 'boolean') value['restoreEnabled'] = patch.restoreEnabled;
    if (typeof patch.previousEnabled === 'boolean') value['previousEnabled'] = patch.previousEnabled;
    await ipcRenderer.invoke('kimi:remote-control-restore-state-set', value);
  },
  onRemoteControlRestoreFinished: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on('kimi:remote-control-restore-finished', listener);
    return () => ipcRenderer.removeListener('kimi:remote-control-restore-finished', listener);
  },
  getCanaryInfo: async () => {
    const info = asCanaryInfo(await ipcRenderer.invoke('kimi:canary-get-info'));
    return info ?? { enabled: false, isCanaryBuild: false, isRealCanaryBuild: false };
  },
  canaryImportStableSettings: async () => {
    const result = asCanaryStableImportResult(await ipcRenderer.invoke('kimi:canary-import-stable-settings'));
    return result ?? { status: 'error', error: 'invalid canary-import-stable-settings response' };
  },
  getRuntimeEnvironmentOverrides: async () => {
    const result = asRuntimeEnvironmentGetResult(await ipcRenderer.invoke('kimi:runtime-environment-get'));
    return result ?? { status: 'error', error: 'invalid runtime-environment-get response' };
  },
  saveRuntimeEnvironmentOverrides: async (overrides) => {
    const request = asRuntimeEnvironmentOverrides(overrides);
    if (request === null) return { status: 'error', error: 'invalid runtime environment overrides' };
    const result = asRuntimeEnvironmentSaveResult(await ipcRenderer.invoke('kimi:runtime-environment-save', request));
    return result ?? { status: 'error', error: 'invalid runtime-environment-save response' };
  },
  resetRuntimeEnvironmentOverrides: async () => {
    const result = asRuntimeEnvironmentSaveResult(await ipcRenderer.invoke('kimi:runtime-environment-reset'));
    return result ?? { status: 'error', error: 'invalid runtime-environment-reset response' };
  },
};
