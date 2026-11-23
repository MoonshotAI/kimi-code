<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatDuration } from '@moonshot-ai/app-core/lib';
import WorkingIndicator from './WorkingIndicator.vue';

defineProps<{
  label?: string;
}>();

const { t } = useI18n();

const startedAt = Date.now();
const elapsedMs = ref(0);
const pageHidden = ref(false);
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function stopTimer(): void {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function syncTimer(): void {
  if (pageHidden.value) {
    stopTimer();
    return;
  }
  elapsedMs.value = Math.max(0, Date.now() - startedAt);
  if (elapsedTimer === null) {
    elapsedTimer = setInterval(() => {
      elapsedMs.value = Math.max(0, Date.now() - startedAt);
    }, 1000);
  }
}

function syncVisibility(): void {
  pageHidden.value = typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

watch(pageHidden, syncTimer);

onMounted(() => {
  if (typeof document !== 'undefined') {
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
  }
  syncTimer();
});

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', syncVisibility);
  }
  stopTimer();
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
  <WorkingIndicator v-if="label" class="activity-notice" :label="label" static-label>
    <span v-if="elapsedLabel" class="an-meta">{{ elapsedLabel }}</span>
  </WorkingIndicator>
  <span v-else-if="elapsedLabel" class="activity-notice an-meta">{{ elapsedLabel }}</span>
</template>

<style scoped>
.activity-notice {
  display: inline-flex;
  align-items: center;
}

.an-meta {
  margin-left: calc(-1 * var(--space-1));
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: 1;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
