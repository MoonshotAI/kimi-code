// apps/desktop/src/renderer/composables/useUpdateStatus.ts
// Desktop-only reactive auto-update status.
//
// The main process (updater.ts) owns electron-updater and pushes every state
// transition over the `kimi:update-status` bridge event; the initial status is
// queried once (invoke) so a renderer (re)load after an update was already
// found/downloaded still shows the indicator. With no bridge (plain web,
// tests) the status stays `idle` and nothing renders — the no-bridge
// fallback, per native-todos.md.
//
// `visible` rules: every non-idle state shows — including a background
// download's live progress, so the user can watch an auto-downloaded update
// land. The only exception is an `available` version the user chose to skip
// ("本次跳过" in the dialog): the choice is persisted in localStorage and
// lifts as soon as a different version shows up. The auto-download
// preference never affects visibility: it only decides whether FUTURE
// checks start downloading on their own (main-side electron-updater flag).
//
// Consumers: the sidebar UpdateIndicator, and settings → advanced (the manual
// "check for updates" row uses `canCheck` / `check`; the auto-download toggle
// uses `canToggleAutoDownload` / `autoDownload` / `setAutoDownload`).

import { computed, ref, type Ref } from 'vue';

import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from '../lib/storage';

export type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
  /** Bilingual changelog for the version, fetched main-side (best-effort). */
  releaseNotes?: { zh?: string; en?: string };
}

/** Outcome of a manual "check for updates" (settings → advanced). Mirrors the
    preload bridge's UpdateCheckResult; 'unsupported' = dev / unpackaged build. */
export type UpdateCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  | { outcome: 'unsupported' }
  | { outcome: 'error'; message: string };

// Subset of the preload `kimiDesktop` bridge this tracker needs. Older desktop
// builds lack `checkForUpdates` — feature-detect it before exposing the UI.
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
  /** Whether the sidebar indicator should render (state minus user skips). */
  visible: Ref<boolean>;
  /** Whether a manual update check is wired up (false in plain web and on
      desktop builds whose bridge predates `checkForUpdates` — hide the row). */
  canCheck: boolean;
  /** Background-download preference (persisted main-side). Drives the
      settings toggle and the dialog checkbox — a pure preference, it never
      affects `visible` nor starts the currently waiting download. */
  autoDownload: Ref<boolean>;
  /** Whether the auto-download toggle is wired up (bridge feature-detect —
      hide the settings row in plain web / older bridges). */
  canToggleAutoDownload: boolean;
  /** Flip the preference: updates the local ref immediately and persists
      main-side. */
  setAutoDownload: (enabled: boolean) => void;
  /** "本次跳过": hide this version until a different one appears (persisted). */
  skipVersion: () => void;
  /** User-initiated check; resolves with the outcome for inline feedback. */
  check: () => Promise<UpdateCheckResult>;
  /** Start downloading the available update (no-op unless available/error). */
  download: () => void;
  /** Quit and install the downloaded update (no-op unless downloaded). */
  install: () => void;
}

const IDLE: UpdateStatus = { state: 'idle' };

export function createUpdateTracker(bridge: UpdateBridge | undefined): UpdateTracker {
  const status = ref<UpdateStatus>(IDLE);
  const skippedVersion = ref<string | null>(safeGetString(STORAGE_KEYS.updateSkippedVersion));
  // Mirrors the main-process default (disabled); the persisted value
  // replaces it below.
  const autoDownload = ref(false);

  if (typeof bridge?.getUpdateAutoDownload === 'function') {
    void bridge
      .getUpdateAutoDownload()
      .then((enabled) => {
        autoDownload.value = enabled;
      })
      .catch(() => {
        // Bridge failure: keep the default (disabled), same as the main side.
      });
  }

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
    canCheck: typeof bridge?.checkForUpdates === 'function',
    autoDownload,
    canToggleAutoDownload:
      typeof bridge?.getUpdateAutoDownload === 'function' && typeof bridge?.setUpdateAutoDownload === 'function',
    setAutoDownload: (enabled) => {
      autoDownload.value = enabled;
      void bridge?.setUpdateAutoDownload?.(enabled).catch(() => {});
    },
    skipVersion: () => {
      const version = status.value.version;
      if (status.value.state === 'available' && version !== undefined) {
        skippedVersion.value = version;
        safeSetString(STORAGE_KEYS.updateSkippedVersion, version);
      }
    },
    check: async () => {
      if (typeof bridge?.checkForUpdates !== 'function') {
        return Promise.resolve({ outcome: 'unsupported' });
      }
      const result = await bridge
        .checkForUpdates()
        .catch((): UpdateCheckResult => ({ outcome: 'error', message: 'bridge call failed' }));
      // A manual check is update intent: when it finds the exact version the
      // user previously skipped, lift the skip so the sidebar entry appears —
      // the settings hint points there for the download, and without this the
      // pill would stay hidden with no actionable path.
      if (result.outcome === 'available' && result.version !== undefined && result.version === skippedVersion.value) {
        skippedVersion.value = null;
        safeRemove(STORAGE_KEYS.updateSkippedVersion);
      }
      return result;
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
