// packages/app-client/src/composables/useCanaryChannel.ts
// Kimi Code Canary channel — desktop-only identity + gh readiness + the
// trigger-build action.
//
// Auto-update does NOT live here: canary builds update through the standard
// update tracker (useUpdateStatus — main drives electron-updater with the
// GitHub provider, canary-updater.ts). This composable only keeps what the
// debug menu needs:
//   - `enabled` / `isCanaryBuild`: visibility gates (dev / canary build;
//     stable builds and plain web stay hidden — the no-bridge fallback, per
//     native-todos.md);
//   - `gh` / `actionsUrl`: gh CLI readiness hints + the workflow page link;
//   - `triggerBuild()`: the「重新打包 Canary」action.
//
// Consumers: the sidebar DebugMenu.

import { ref, type Ref } from 'vue';

export type CanaryGhState = 'ok' | 'missing' | 'unauthenticated' | 'error';

export interface CanaryInfo {
  enabled: boolean;
  isCanaryBuild: boolean;
  gh: CanaryGhState;
  actionsUrl: string;
}

export type CanaryTriggerResult = { ok: boolean; error?: string };

// Subset of the preload `kimiDesktop` bridge this tracker needs. Older desktop
// builds (and plain web) lack it — feature-detect before exposing the UI.
interface CanaryBridge {
  getCanaryInfo: () => Promise<CanaryInfo>;
  triggerCanaryBuild: () => Promise<CanaryTriggerResult>;
}

export interface CanaryTracker {
  /** Whether the canary UI shows at all (canary build / dev, per main). */
  enabled: Ref<boolean>;
  /** True only on a real canary build — drives the always-on sidebar badge
      (dev runs of the stable app stay quiet). */
  isCanaryBuild: Ref<boolean>;
  /** gh CLI readiness on this machine (menu hints / action gating). */
  gh: Ref<CanaryGhState>;
  /** Workflow page URL (debug 菜单「查看流水线」link). */
  actionsUrl: Ref<string>;
  /** Fire the canary build workflow (confirm lives in the view). */
  triggerBuild: () => Promise<CanaryTriggerResult>;
}

function hasBridge(bridge: Partial<CanaryBridge> | undefined): bridge is CanaryBridge {
  return (
    typeof bridge?.getCanaryInfo === 'function' && typeof bridge?.triggerCanaryBuild === 'function'
  );
}

export function createCanaryTracker(bridge: CanaryBridge | undefined): CanaryTracker {
  const enabled = ref(false);
  const isCanaryBuild = ref(false);
  const gh = ref<CanaryGhState>('missing');
  const actionsUrl = ref('');

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
  }

  return {
    enabled,
    isCanaryBuild,
    gh,
    actionsUrl,
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
