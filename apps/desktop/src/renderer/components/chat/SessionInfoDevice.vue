<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, ProgressBar, Tooltip } from '@moonshot-ai/app-ui';
import { useDeviceStats, type DeviceStatsTarget } from '@moonshot-ai/app-client/composables';
import { devicesStore } from '@moonshot-ai/app-client/stores';
import { formatByteSize } from '@moonshot-ai/app-core/lib';

const HIGH_USAGE = 0.9;

const props = defineProps<{
  target?: DeviceStatsTarget;
}>();

interface Meter {
  readonly key: string;
  readonly label: string;
  readonly ratio?: number;
  readonly detail: string;
}

const { t } = useI18n();
const { stats, stale } = useDeviceStats(() => props.target);
const expanded = ref(true);

function percent(ratio: number | undefined): string {
  return ratio === undefined ? '—' : `${String(Math.round(ratio * 100))}%`;
}

function share(used: number, total: number): number | undefined {
  return total > 0 ? Math.min(1, used / total) : undefined;
}

function withLimit(detail: string, limited: boolean): string {
  return limited ? `${detail} · ${t('header.sessionInfoDeviceLimit')}` : detail;
}

const name = computed(() => {
  const deviceId = props.target?.deviceId;
  return deviceId === undefined ? '' : (devicesStore().displayName(deviceId) ?? deviceId);
});

const meters = computed<Meter[]>(() => {
  const current = stats.value;
  if (current === null) return [];
  const { cpu, memory, disk } = current;
  const rows: Meter[] = [
    {
      key: 'cpu',
      label: t('header.sessionInfoDeviceCpu'),
      ratio: cpu.usage,
      detail: withLimit(t('header.sessionInfoDeviceCores', { count: Number(cpu.cores.toFixed(1)) }), cpu.limited),
    },
    {
      key: 'memory',
      label: t('header.sessionInfoDeviceMemory'),
      ratio: share(memory.used, memory.total),
      detail: withLimit(
        t('header.sessionInfoDeviceUsedOf', { used: formatByteSize(memory.used), total: formatByteSize(memory.total) }),
        memory.limited,
      ),
    },
  ];
  if (disk !== undefined) {
    rows.push({
      key: 'disk',
      label: t('header.sessionInfoDeviceDisk'),
      ratio: share(disk.used, disk.used + disk.available),
      detail: `${t('header.sessionInfoDeviceFreeOf', { free: formatByteSize(disk.available), total: formatByteSize(disk.total) })} · ${disk.path}`,
    });
  }
  return rows;
});

const gpus = computed<Meter[]>(() =>
  (stats.value?.gpus ?? []).map((gpu) => {
    const parts = [t('header.sessionInfoDeviceGpu', { index: gpu.index, name: gpu.name })];
    if (gpu.memoryUsed !== undefined && gpu.memoryTotal !== undefined) {
      parts.push(t('header.sessionInfoDeviceUsedOf', { used: formatByteSize(gpu.memoryUsed), total: formatByteSize(gpu.memoryTotal) }));
    }
    if (gpu.utilization !== undefined) parts.push(t('header.sessionInfoDeviceGpuBusy', { percent: percent(gpu.utilization) }));
    return {
      key: `gpu-${String(gpu.index)}`,
      label: parts[0]!,
      ratio: gpu.memoryUsed === undefined || gpu.memoryTotal === undefined ? undefined : share(gpu.memoryUsed, gpu.memoryTotal),
      detail: parts.join(' · '),
    };
  }),
);

const gpuMemoryRatio = computed(() => {
  let used = 0;
  let total = 0;
  for (const gpu of stats.value?.gpus ?? []) {
    if (gpu.memoryUsed === undefined || gpu.memoryTotal === undefined) continue;
    used += gpu.memoryUsed;
    total += gpu.memoryTotal;
  }
  return share(used, total);
});

const summary = computed(() =>
  meters.value
    .filter((meter) => meter.key !== 'disk')
    .map((meter) => `${meter.label} ${percent(meter.ratio)}`)
    .join(' · '),
);

function high(ratio: number | undefined): boolean {
  return ratio !== undefined && ratio >= HIGH_USAGE;
}
</script>

<template>
  <section v-if="stats !== null" class="si-device" :class="{ 'is-collapsed': !expanded, 'is-stale': stale }">
    <button class="sid-heading" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="sid-title">{{ t('header.sessionInfoDeviceTitle', { name }) }}</span>
      <span v-if="!expanded" class="sid-summary">{{ summary }}</span>
      <Icon class="sid-chevron" :class="{ collapsed: !expanded }" name="chevron-down" size="sm" />
    </button>
    <div v-if="expanded" class="sid-body">
      <Tooltip v-for="meter in meters" :key="meter.key" :text="meter.detail">
        <div class="sid-row" :class="{ 'is-high': high(meter.ratio) }">
          <span class="sid-label">{{ meter.label }}</span>
          <ProgressBar class="sid-meter" :value="meter.ratio ?? 0" :label="`${meter.label} ${percent(meter.ratio)}`" />
          <span class="sid-value">{{ percent(meter.ratio) }}</span>
        </div>
      </Tooltip>
      <div v-if="gpus.length > 0" class="sid-row" :class="{ 'is-high': high(gpuMemoryRatio) }">
        <span class="sid-label">{{ t('header.sessionInfoDeviceGpuMemory') }}</span>
        <span class="sid-gpus">
          <Tooltip v-for="gpu in gpus" :key="gpu.key" :text="gpu.detail">
            <ProgressBar
              class="sid-meter"
              :class="{ 'is-high': high(gpu.ratio) }"
              :value="gpu.ratio ?? 0"
              :label="`${gpu.label} ${percent(gpu.ratio)}`"
            />
          </Tooltip>
        </span>
        <span class="sid-value">{{ percent(gpuMemoryRatio) }}</span>
      </div>
      <p v-if="stale" class="sid-stale">{{ t('header.sessionInfoDeviceStale') }}</p>
    </div>
  </section>
</template>

<style scoped>
.si-device {
  position: relative;
  min-width: 0;
  padding: var(--space-3) var(--space-4) var(--space-4);
}
.si-device.is-collapsed {
  padding-bottom: var(--space-3);
}
.si-device::after {
  content: "";
  position: absolute;
  right: var(--space-4);
  bottom: 0;
  left: var(--space-4);
  height: var(--p-hairline);
  background: var(--color-line);
}
.sid-heading {
  width: 100%;
  min-width: 0;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}
.sid-heading:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.sid-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}
.sid-summary {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.sid-chevron {
  flex: none;
  color: var(--color-text-faint);
  transition: transform var(--duration-fast) var(--ease-out);
}
.sid-chevron.collapsed { transform: rotate(-90deg); }
.sid-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  margin-top: var(--space-1-5);
}
.is-stale .sid-body > :not(.sid-stale) { opacity: 0.55; }
.sid-row {
  display: grid;
  grid-template-columns: 4.5em minmax(0, 1fr) 3em;
  align-items: center;
  gap: var(--space-2);
  min-height: 20px;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.sid-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sid-value {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.sid-row.is-high .sid-value { color: var(--color-warning); }
.sid-gpus {
  display: flex;
  gap: 2px;
  min-width: 0;
}
.sid-gpus .sid-meter { flex: 1; min-width: 0; }
.sid-meter {
  height: var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--color-fill-2);
}
.sid-meter :deep(.ui-progress-bar__indicator) {
  border-radius: inherit;
  background: var(--color-text-faint);
  transition: width var(--duration-base) var(--ease-out);
}
.sid-row.is-high > .sid-meter :deep(.ui-progress-bar__indicator),
.sid-meter.is-high :deep(.ui-progress-bar__indicator) {
  background: var(--color-warning);
}
.sid-stale {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
</style>
