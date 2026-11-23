import { watch, type Ref } from 'vue';

import { markRendererRunning } from '../debug/rendererErrors';

export type StartupMilestone = 'ui-mounted' | 'ui-ready' | 'boot-stage';

interface StartupMilestoneBridge {
  reportStartupMilestone?: (milestone: StartupMilestone, stage?: string) => void;
}

export function reportStartupMilestone(milestone: StartupMilestone, stage?: string): void {
  try {
    (window as { kimiDesktop?: StartupMilestoneBridge }).kimiDesktop?.reportStartupMilestone?.(milestone, stage);
  } catch {
    return;
  }
}

export function watchStartupMilestones(initialized: Readonly<Ref<boolean>>, bootStage: Readonly<Ref<string>>): void {
  let ready = false;
  watch(
    bootStage,
    (stage) => {
      if (!ready && !initialized.value) reportStartupMilestone('boot-stage', stage);
    },
    { immediate: true },
  );
  watch(
    initialized,
    (value) => {
      if (ready || !value) return;
      ready = true;
      reportStartupMilestone('ui-ready');
      markRendererRunning();
    },
    { immediate: true },
  );
}
