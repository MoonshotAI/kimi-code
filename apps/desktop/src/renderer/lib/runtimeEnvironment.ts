import type {
  RuntimeEnvironmentGetResult,
  RuntimeEnvironmentOverrides,
  RuntimeEnvironmentSaveResult,
} from '../../shared/runtime-environment';

export interface RuntimeEnvironmentBridge {
  getRuntimeEnvironmentOverrides: () => Promise<RuntimeEnvironmentGetResult>;
  saveRuntimeEnvironmentOverrides: (overrides: RuntimeEnvironmentOverrides) => Promise<RuntimeEnvironmentSaveResult>;
  resetRuntimeEnvironmentOverrides: () => Promise<RuntimeEnvironmentSaveResult>;
}

export function runtimeEnvironmentBridge(): Partial<RuntimeEnvironmentBridge> | undefined {
  return (window as { kimiDesktop?: Partial<RuntimeEnvironmentBridge> }).kimiDesktop;
}

export function createRuntimeEnvironmentVersionTrigger(
  trigger: () => Promise<void>,
  now: () => number = Date.now,
): () => Promise<void> {
  let clicks = 0;
  let lastClick = Number.NEGATIVE_INFINITY;
  let opening = false;
  return async () => {
    const time = now();
    clicks = time - lastClick > 2_000 ? 1 : clicks + 1;
    lastClick = time;
    if (clicks < 10 || opening) return;
    clicks = 0;
    opening = true;
    try {
      await trigger();
    } finally {
      opening = false;
    }
  };
}
