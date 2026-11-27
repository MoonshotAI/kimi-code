<script setup lang="ts">
import { computed } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';

const props = defineProps<{ label?: string; value?: number }>();
const { t } = useKimiI18n();
const percent = computed(() =>
  props.value === undefined || !Number.isFinite(props.value)
    ? null
    : Math.round(Math.min(1, Math.max(0, props.value)) * 100),
);
</script>

<template>
  <div
    class="ui-progress-bar"
    role="progressbar"
    :aria-label="label ?? t('common.loading')"
    :aria-valuemin="percent === null ? undefined : 0"
    :aria-valuemax="percent === null ? undefined : 100"
    :aria-valuenow="percent ?? undefined"
  >
    <div
      class="ui-progress-bar__indicator"
      :class="{ 'is-determinate': percent !== null }"
      :style="percent === null ? undefined : { width: `${percent}%` }"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.ui-progress-bar {
  height: var(--space-05);
  overflow: hidden;
  background: var(--color-line);
}

.ui-progress-bar__indicator {
  width: calc(100% / 3);
  height: 100%;
  background: var(--color-info);
  transform: translateX(100%);
  animation: ui-progress-bar-travel var(--duration-flash) var(--ease-in-out) infinite;
}

.ui-progress-bar__indicator.is-determinate {
  transform: none;
  animation: none;
}

@keyframes ui-progress-bar-travel {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}
</style>
