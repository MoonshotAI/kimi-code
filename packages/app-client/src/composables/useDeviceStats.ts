import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import type { AppSystemStats } from '@moonshot-ai/app-core/api';
import { getDeviceApi } from '../client/deps';
import { devicesStore } from '../stores/devices';

export const DEVICE_STATS_CAPABILITY = 'system_stats';

const POLL_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export interface DeviceStatsTarget {
  readonly deviceId: string;
  readonly path?: string;
}

export interface DeviceStats {
  readonly stats: Readonly<Ref<AppSystemStats | null>>;
  readonly stale: Readonly<Ref<boolean>>;
}

function usePageVisible(): Readonly<Ref<boolean>> {
  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden');
  if (typeof document === 'undefined') return visible;
  const update = (): void => {
    visible.value = document.visibilityState !== 'hidden';
  };
  document.addEventListener('visibilitychange', update);
  onScopeDispose(() => document.removeEventListener('visibilitychange', update));
  return visible;
}

function targetKey(target: DeviceStatsTarget): string {
  return JSON.stringify([target.deviceId, target.path ?? null]);
}

export function useDeviceStats(source: () => DeviceStatsTarget | undefined): DeviceStats {
  const visible = usePageVisible();
  const current = shallowRef<{ readonly key: string; readonly stats: AppSystemStats } | null>(null);
  const stale = ref(false);
  const target = computed(() => {
    const next = source();
    if (next === undefined) return undefined;
    const devices = devicesStore();
    if (devices.displayState(next.deviceId) !== 'ready' || !devices.supports(next.deviceId, DEVICE_STATS_CAPABILITY)) return undefined;
    return next;
  });

  watch(
    () => (target.value === undefined || !visible.value ? undefined : targetKey(target.value)),
    (key, _previous, onCleanup) => {
      const polled = target.value;
      if (key === undefined || polled === undefined) return;
      let stopped = false;
      let delay = POLL_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let request: AbortController | undefined;
      const poll = async (): Promise<void> => {
        request = new AbortController();
        try {
          const stats = await getDeviceApi(polled.deviceId).getSystemStats(polled.path, { background: true, signal: request.signal });
          if (stopped) return;
          current.value = { key, stats };
          stale.value = false;
          delay = POLL_MS;
        } catch {
          if (stopped) return;
          stale.value = true;
          delay = Math.min(delay * 2, MAX_RETRY_MS);
        }
        timer = setTimeout(() => void poll(), delay);
      };
      void poll();
      onCleanup(() => {
        stopped = true;
        clearTimeout(timer);
        request?.abort();
      });
    },
    { immediate: true },
  );

  const stats = computed(() => {
    const shown = target.value;
    return shown !== undefined && current.value?.key === targetKey(shown) ? current.value.stats : null;
  });
  return { stats, stale };
}
