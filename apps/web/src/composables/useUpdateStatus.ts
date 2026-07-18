// apps/web/src/composables/useUpdateStatus.ts
// Desktop-only reactive auto-update status.
//
// The main process (updater.ts) owns electron-updater and pushes every state
// transition over the `kimi:update-status` bridge event; the initial status is
// queried once (invoke) so a renderer (re)load after an update was already
// found/downloaded still shows the indicator. With no bridge (plain web,
// tests) the status stays `idle` and nothing renders — the no-bridge
// fallback, per native-todos.md.
//
// `visible` additionally hides the `available` state for a version the user
// chose to skip ("本次跳过" in the dialog): the choice is persisted in
// localStorage and lifts as soon as a different version shows up.
//
// Sole consumer today: the sidebar UpdateIndicator.

import { computed, ref, type Ref } from 'vue';

import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';

export type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
}

// Subset of the preload `kimiDesktop` bridge this tracker needs.
interface UpdateBridge {
  getUpdateStatus: () => Promise<UpdateStatus>;
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

export interface UpdateTracker {
  status: Ref<UpdateStatus>;
  /** Whether the sidebar indicator should render (state minus user skips). */
  visible: Ref<boolean>;
  /** "本次跳过": hide this version until a different one appears (persisted). */
  skipVersion: () => void;
  /** Start downloading the available update (no-op unless available/error). */
  download: () => void;
  /** Quit and install the downloaded update (no-op unless downloaded). */
  install: () => void;
}

const IDLE: UpdateStatus = { state: 'idle' };

export function createUpdateTracker(bridge: UpdateBridge | undefined): UpdateTracker {
  const status = ref<UpdateStatus>(IDLE);
  const skippedVersion = ref<string | null>(safeGetString(STORAGE_KEYS.updateSkippedVersion));

  if (bridge !== undefined) {
    // Register the push listener BEFORE taking the snapshot: a status pushed
    // between the invoke and its resolution must win over the (now stale)
    // initial value, or a fresh update would vanish until the next event.
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
      .catch(() => {
        // Bridge failure: keep the idle state, indicator stays hidden.
      });
  }

  const visible = computed(() => {
    const s = status.value;
    if (s.state === 'idle') {
      return false;
    }
    // A skipped version stays hidden while it remains the available one; any
    // other state (already downloading/downloaded, or a newer version) shows.
    if (s.state === 'available' && s.version !== undefined && s.version === skippedVersion.value) {
      return false;
    }
    return true;
  });

  return {
    status,
    visible,
    skipVersion: () => {
      const version = status.value.version;
      if (status.value.state === 'available' && version !== undefined) {
        skippedVersion.value = version;
        safeSetString(STORAGE_KEYS.updateSkippedVersion, version);
      }
    },
    download: () => {
      void bridge?.downloadUpdate().catch(() => {});
    },
    install: () => {
      void bridge?.installUpdate().catch(() => {});
    },
  };
}

// Singleton: the bridge subscription lives for the app's lifetime.
let tracker: UpdateTracker | null = null;

export function useUpdateStatus(): UpdateTracker {
  if (tracker === null) {
    tracker = createUpdateTracker((window as { kimiDesktop?: UpdateBridge }).kimiDesktop);
  }
  return tracker;
}
