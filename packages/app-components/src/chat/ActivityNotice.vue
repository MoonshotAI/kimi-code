<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatDuration } from '@moonshot-ai/app-core/lib';

const { t } = useI18n();
const startedAt = Date.now();
const elapsedMs = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timer = setInterval(() => {
    elapsedMs.value = Math.max(0, Date.now() - startedAt);
  }, 1000);
});

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
});

const elapsedLabel = computed(() => {
  if (elapsedMs.value < 1000) return '';
  return formatDuration(elapsedMs.value, {
    h: t('status.timeUnitHour'),
    m: t('status.timeUnitMinute'),
    s: t('status.timeUnitSecond'),
  });
});
</script>

<template>
  <span v-if="elapsedLabel" class="activity-notice">{{ elapsedLabel }}</span>
</template>

<style scoped>
.activity-notice {
  margin-left: calc(-1 * var(--space-1));
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: 1;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
