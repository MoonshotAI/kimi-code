
import { ref, type Ref } from 'vue';

export interface CanaryInfo {
  enabled: boolean;
  isCanaryBuild: boolean;
  isRealCanaryBuild: boolean;
}

export type CanaryStableImportResult = {
  status: 'relaunching' | 'unavailable' | 'no-stable-data' | 'stable-running' | 'error' | 'cancelled';
  error?: string;
};

interface CanaryBridge {
  getCanaryInfo: () => Promise<CanaryInfo>;
  canaryImportStableSettings?: () => Promise<CanaryStableImportResult>;
}

export interface CanaryTracker {
  enabled: Ref<boolean>;
  isCanaryBuild: Ref<boolean>;
  isRealCanaryBuild: Ref<boolean>;
  importStableSettings: () => Promise<CanaryStableImportResult>;
}

function hasBridge(bridge: Partial<CanaryBridge> | undefined): bridge is CanaryBridge {
  return typeof bridge?.getCanaryInfo === 'function';
}

export function createCanaryTracker(bridge: CanaryBridge | undefined): CanaryTracker {
  const enabled = ref(false);
  const isCanaryBuild = ref(false);
  const isRealCanaryBuild = ref(false);

  if (bridge !== undefined) {
    bridge
      .getCanaryInfo()
      .then((info) => {
        enabled.value = info.enabled;
        isCanaryBuild.value = info.isCanaryBuild;
        isRealCanaryBuild.value = info.isRealCanaryBuild;
      })
      .catch(() => {});
  }

  return {
    enabled,
    isCanaryBuild,
    isRealCanaryBuild,
    importStableSettings: () => {
      if (bridge === undefined || typeof bridge.canaryImportStableSettings !== 'function') {
        return Promise.resolve({ status: 'unavailable' as const });
      }
      return bridge
        .canaryImportStableSettings()
        .catch((): CanaryStableImportResult => ({ status: 'error', error: 'bridge call failed' }));
    },
  };
}

let tracker: CanaryTracker | null = null;

export function useCanaryChannel(): CanaryTracker {
  if (tracker === null) {
    const bridge = (window as { kimiDesktop?: Partial<CanaryBridge> }).kimiDesktop;
    tracker = createCanaryTracker(hasBridge(bridge) ? bridge : undefined);
  }
  return tracker;
}
