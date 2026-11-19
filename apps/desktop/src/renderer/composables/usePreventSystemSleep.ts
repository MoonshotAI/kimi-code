import { onMounted, onUnmounted, reactive, readonly, ref, type DeepReadonly, type Ref } from 'vue';

import type { PreventSleepState, SleepPreventionMode } from '../../shared/prevent-sleep';

interface PreventSleepBridge {
  getPreventSleepState: () => Promise<PreventSleepState>;
  setPreventSystemSleep: (mode: SleepPreventionMode) => Promise<PreventSleepState>;
  setPreventLidSleep: (enabled: boolean) => Promise<PreventSleepState>;
}

function bridge(): PreventSleepBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as { kimiDesktop?: PreventSleepBridge }).kimiDesktop;
}

export function usePreventSystemSleep(): {
  preventSleepState: DeepReadonly<PreventSleepState>;
  lidSleepStopped: Readonly<Ref<boolean>>;
  setPreventSystemSleep: (mode: SleepPreventionMode) => Promise<void>;
  setPreventLidSleep: (enabled: boolean) => Promise<void>;
} {
  const state = reactive<PreventSleepState>({ system: 'allow-sleep', lid: false, lidSupported: false });
  const lidSleepStopped = ref(false);
  let revision = 0;
  let disposed = false;
  let querying = false;
  let mutations = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    const b = bridge();
    if (typeof b?.getPreventSleepState !== 'function' || querying || mutations > 0) return;
    const requestedRevision = revision;
    querying = true;
    try {
      const next = await b.getPreventSleepState();
      if (!disposed && requestedRevision === revision) {
        if (state.lid && !next.lid) lidSleepStopped.value = true;
        Object.assign(state, { lidNeedsRepair: false }, next);
      }
    } catch {
      return;
    } finally {
      querying = false;
    }
  }

  onMounted(() => {
    if (bridge() === undefined) return;
    void refresh();
    timer = setInterval(() => { void refresh(); }, 2000);
  });
  onUnmounted(() => {
    disposed = true;
    clearInterval(timer);
  });

  async function setPreventSystemSleep(mode: SleepPreventionMode): Promise<void> {
    const b = bridge();
    if (typeof b?.setPreventSystemSleep !== 'function') {
      state.system = mode;
      if (mode === 'allow-sleep') state.lid = false;
      return;
    }
    revision++;
    mutations++;
    try {
      Object.assign(state, { lidNeedsRepair: false }, await b.setPreventSystemSleep(mode));
    } finally {
      mutations--;
    }
  }

  async function setPreventLidSleep(on: boolean): Promise<void> {
    lidSleepStopped.value = false;
    const b = bridge();
    if (typeof b?.setPreventLidSleep !== 'function') {
      state.lid = on;
      return;
    }
    revision++;
    mutations++;
    try {
      Object.assign(state, { lidNeedsRepair: false }, await b.setPreventLidSleep(on));
    } finally {
      mutations--;
    }
  }

  return { preventSleepState: readonly(state), lidSleepStopped: readonly(lidSleepStopped), setPreventSystemSleep, setPreventLidSleep };
}
