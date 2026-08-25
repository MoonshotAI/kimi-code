// packages/app-client/src/composables/useCanaryChannel.ts
// Kimi Code Canary channel — desktop-only reactive status.
//
// The main process (apps/desktop/src/main/canary.ts) owns the gh-driven check
// loop and pushes every transition over the `kimi:canary-status` bridge event;
// the initial status is queried once so a renderer (re)load still shows the
// pill. With no bridge (plain web, tests) or on stable packaged builds
// (`CanaryInfo.enabled === false`) everything stays idle/hidden — the
// no-bridge fallback, per native-todos.md.
//
// `visible` rules mirror useUpdateStatus: every non-idle state shows, except
// an `available` version the user skipped ("本次跳过" in the dialog) — the
// choice is persisted in localStorage and lifts when a different version (or
// a manual check hitting the same one) shows up.
//
// Consumers: the sidebar UpdateIndicator (canary mode), the Sidebar Canary
// badge, and settings → advanced (manual check + trigger-build rows).

import { computed, ref, type Ref } from 'vue';

import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

export type CanaryState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface CanaryStatus {
  state: CanaryState;
  version?: string;
  tag?: string;
  releaseDate?: string;
  path?: string;
  message?: string;
}

export type CanaryGhState = 'ok' | 'missing' | 'unauthenticated' | 'error';

export interface CanaryInfo {
  enabled: boolean;
  isCanaryBuild: boolean;
  gh: CanaryGhState;
  actionsUrl: string;
}

/** Outcome of a settings-row manual canary check (mirrors the preload bridge). */
export type CanaryCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  | { outcome: 'gh-missing' }
  | { outcome: 'gh-unauthenticated' }
  | { outcome: 'error'; message: string };

export type CanaryTriggerResult = { ok: boolean; error?: string };

// Subset of the preload `kimiDesktop` bridge this tracker needs. Older desktop
// builds (and plain web) lack it — feature-detect before exposing the UI.
interface CanaryBridge {
  getCanaryStatus: () => Promise<CanaryStatus>;
  onCanaryStatus: (cb: (status: CanaryStatus) => void) => () => void;
  getCanaryInfo: () => Promise<CanaryInfo>;
  checkCanaryUpdate: () => Promise<CanaryCheckResult>;
  downloadCanaryUpdate: () => Promise<void>;
  openCanaryDownload: () => Promise<void>;
  triggerCanaryBuild: () => Promise<CanaryTriggerResult>;
}

export interface CanaryTracker {
  /** Whether the canary UI shows at all (canary build / dev, per main). */
  enabled: Ref<boolean>;
  /** True only on a real canary build — drives the always-on sidebar badge
      (dev runs of the stable app stay quiet). */
  isCanaryBuild: Ref<boolean>;
  /** gh CLI readiness on this machine (settings-row hints). */
  gh: Ref<CanaryGhState>;
  /** Workflow page URL (设置页「查看流水线」link). */
  actionsUrl: Ref<string>;
  status: Ref<CanaryStatus>;
  /** Whether the sidebar pill should render (state minus user skips). */
  visible: Ref<boolean>;
  /** "本次跳过": hide this version until a different one appears (persisted). */
  skipVersion: () => void;
  /** Settings-row manual check; resolves with the outcome for inline feedback. */
  check: () => Promise<CanaryCheckResult>;
  /** Download the available canary dmg and mount it (no-op unless available/error). */
  download: () => void;
  /** Re-open the already-downloaded dmg. */
  openDownload: () => void;
  /** Fire the canary build workflow (two-step confirm lives in the view). */
  triggerBuild: () => Promise<CanaryTriggerResult>;
}

const IDLE: CanaryStatus = { state: 'idle' };

function hasBridge(bridge: Partial<CanaryBridge> | undefined): bridge is CanaryBridge {
  return (
    typeof bridge?.getCanaryStatus === 'function' &&
    typeof bridge?.onCanaryStatus === 'function' &&
    typeof bridge?.getCanaryInfo === 'function' &&
    typeof bridge?.checkCanaryUpdate === 'function' &&
    typeof bridge?.downloadCanaryUpdate === 'function' &&
    typeof bridge?.openCanaryDownload === 'function' &&
    typeof bridge?.triggerCanaryBuild === 'function'
  );
}

export function createCanaryTracker(bridge: CanaryBridge | undefined): CanaryTracker {
  const enabled = ref(false);
  const isCanaryBuild = ref(false);
  const gh = ref<CanaryGhState>('missing');
  const actionsUrl = ref('');
  const status = ref<CanaryStatus>(IDLE);
  const skippedVersion = ref<string | null>(safeGetString(STORAGE_KEYS.canarySkippedVersion));

  if (bridge !== undefined) {
    bridge
      .getCanaryInfo()
      .then((info) => {
        enabled.value = info.enabled;
        isCanaryBuild.value = info.isCanaryBuild;
        gh.value = info.gh;
        actionsUrl.value = info.actionsUrl;
      })
      .catch(() => {
        // Bridge failure: keep everything hidden.
      });
    // Register the push listener BEFORE taking the snapshot (same race as
    // useUpdateStatus): a status pushed between invoke and resolution must win.
    let pushed = false;
    bridge.onCanaryStatus((next) => {
      pushed = true;
      status.value = next;
    });
    void bridge
      .getCanaryStatus()
      .then((initial) => {
        if (!pushed) {
          status.value = initial;
        }
      })
      .catch(() => {
        // Bridge failure: keep the idle state, pill stays hidden.
      });
  }

  const visible = computed(() => {
    if (!enabled.value) {
      return false;
    }
    const s = status.value;
    if (s.state === 'idle') {
      return false;
    }
    if (s.state === 'available' && s.version !== undefined && s.version === skippedVersion.value) {
      return false;
    }
    return true;
  });

  return {
    enabled,
    isCanaryBuild,
    gh,
    actionsUrl,
    status,
    visible,
    skipVersion: () => {
      const version = status.value.version;
      if (status.value.state === 'available' && version !== undefined) {
        skippedVersion.value = version;
        safeSetString(STORAGE_KEYS.canarySkippedVersion, version);
      }
    },
    check: async () => {
      if (bridge === undefined) {
        return { outcome: 'error', message: 'no canary bridge' };
      }
      const result = await bridge
        .checkCanaryUpdate()
        .catch((): CanaryCheckResult => ({ outcome: 'error', message: 'bridge call failed' }));
      // A manual check is update intent: finding the exact skipped version
      // lifts the skip so the sidebar entry appears (same rule as updates).
      if (result.outcome === 'available' && result.version !== undefined && result.version === skippedVersion.value) {
        skippedVersion.value = null;
        safeRemove(STORAGE_KEYS.canarySkippedVersion);
      }
      return result;
    },
    download: () => {
      void bridge?.downloadCanaryUpdate().catch(() => {});
    },
    openDownload: () => {
      void bridge?.openCanaryDownload().catch(() => {});
    },
    triggerBuild: () => {
      if (bridge === undefined) {
        return Promise.resolve({ ok: false, error: 'no canary bridge' });
      }
      return bridge.triggerCanaryBuild().catch((): CanaryTriggerResult => ({ ok: false, error: 'bridge call failed' }));
    },
  };
}

// Singleton: the bridge subscription lives for the app's lifetime.
let tracker: CanaryTracker | null = null;

export function useCanaryChannel(): CanaryTracker {
  if (tracker === null) {
    const bridge = (window as { kimiDesktop?: Partial<CanaryBridge> }).kimiDesktop;
    tracker = createCanaryTracker(hasBridge(bridge) ? bridge : undefined);
  }
  return tracker;
}
