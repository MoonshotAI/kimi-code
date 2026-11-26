
import { computed, ref, type Ref } from 'vue';

import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { track } from '../contracts';

export type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
  releaseNotes?: { zh?: string; en?: string };
}

export type UpdateCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  | { outcome: 'unsupported' }
  | { outcome: 'error'; message: string };

interface UpdateBridge {
  getUpdateStatus: () => Promise<UpdateStatus>;
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void;
  checkForUpdates?: () => Promise<UpdateCheckResult>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  getUpdateAutoDownload?: () => Promise<boolean>;
  setUpdateAutoDownload?: (enabled: boolean) => Promise<void>;
}

export interface UpdateTracker {
  status: Ref<UpdateStatus>;
  visible: Ref<boolean>;
  dialogOpen: Ref<boolean>;
  canCheck: boolean;
  autoDownload: Ref<boolean>;
  canToggleAutoDownload: boolean;
  setAutoDownload: (enabled: boolean, source: 'settings' | 'update_prompt') => void;
  skipVersion: () => void;
  openDialog: () => void;
  check: () => Promise<UpdateCheckResult>;
  checkAndOpen: () => Promise<UpdateCheckResult>;
  download: () => void;
  install: () => Promise<void>;
}

const IDLE: UpdateStatus = { state: 'idle' };

export function createUpdateTracker(bridge: UpdateBridge | undefined): UpdateTracker {
  const status = ref<UpdateStatus>(IDLE);
  const dialogOpen = ref(false);
  const skippedVersion = ref<string | null>(safeGetString(STORAGE_KEYS.updateSkippedVersion));
  const autoDownload = ref(false);

  if (typeof bridge?.getUpdateAutoDownload === 'function') {
    void bridge
      .getUpdateAutoDownload()
      .then((enabled) => {
        autoDownload.value = enabled;
      })
      .catch(() => {});
  }

  if (bridge !== undefined) {
    let pushed = false;
    bridge.onUpdateStatus((next) => {
      pushed = true;
      status.value = next;
    });
    void bridge
      .getUpdateStatus()
      .then((initial) => {
        if (!pushed) {
          status.value = initial;
        }
      })
      .catch(() => {});
  }

  const visible = computed(() => {
    const s = status.value;
    if (s.state === 'idle') {
      return false;
    }
    if (s.state === 'available' && s.version !== undefined && s.version === skippedVersion.value) {
      return false;
    }
    return true;
  });

  const download = (): void => {
    void bridge?.downloadUpdate().catch(() => {});
  };

  const clearSkippedVersion = (version?: string): void => {
    if (version === undefined || version !== skippedVersion.value) return;
    skippedVersion.value = null;
    safeRemove(STORAGE_KEYS.updateSkippedVersion);
  };

  const check = async (): Promise<UpdateCheckResult> => {
    if (typeof bridge?.checkForUpdates !== 'function') {
      return { outcome: 'unsupported' };
    }
    const result = await bridge
      .checkForUpdates()
      .catch((): UpdateCheckResult => ({ outcome: 'error', message: 'bridge call failed' }));
    if (result.outcome === 'available') {
      clearSkippedVersion(result.version);
    }
    return result;
  };

  const checkAndOpen = async (): Promise<UpdateCheckResult> => {
    const result = await check();
    if (result.outcome !== 'available') return result;
    dialogOpen.value = true;
    return result;
  };

  return {
    status,
    visible,
    dialogOpen,
    canCheck: typeof bridge?.checkForUpdates === 'function',
    autoDownload,
    canToggleAutoDownload:
      typeof bridge?.getUpdateAutoDownload === 'function' && typeof bridge?.setUpdateAutoDownload === 'function',
    setAutoDownload: (enabled, source) => {
      autoDownload.value = enabled;
      if (typeof bridge?.setUpdateAutoDownload !== 'function') return;
      void bridge
        .setUpdateAutoDownload(enabled)
        .then(() => {
          track('settings_changed', {
            key: 'update-auto-download',
            value: enabled ? 'on' : 'off',
            source_panel: source,
          });
        })
        .catch(() => {});
    },
    skipVersion: () => {
      const version = status.value.version;
      if (status.value.state === 'available' && version !== undefined) {
        skippedVersion.value = version;
        safeSetString(STORAGE_KEYS.updateSkippedVersion, version);
      }
    },
    openDialog: () => {
      clearSkippedVersion(status.value.version);
      dialogOpen.value = true;
    },
    check,
    checkAndOpen,
    download,
    install: async () => {
      await bridge?.installUpdate();
    },
  };
}

let tracker: UpdateTracker | null = null;

export function useUpdateStatus(): UpdateTracker {
  if (tracker === null) {
    tracker = createUpdateTracker((window as { kimiDesktop?: UpdateBridge }).kimiDesktop);
  }
  return tracker;
}
