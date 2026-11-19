<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { cronScheduleText } from '@moonshot-ai/app-core/lib';
import MessageTime from './MessageTime.vue';
import type { CronTurnData } from '@moonshot-ai/app-core/client/types';

const props = defineProps<{
  text: string;
  cron?: CronTurnData;
  turnId?: string;
  createdAt?: string;
}>();

const { t } = useI18n();

const cron = computed(() => props.cron);
const missed = computed(() => cron.value?.missedCount !== undefined);

const title = computed(() =>
  missed.value ? t('conversation.cron.missed') : t('conversation.cron.fired'),
);

const schedule = computed(() => {
  const c = cron.value;
  if (!c?.cron || c.recurring === false) return '';
  return cronScheduleText(t, c.cron);
});

const statusKind = computed<'ok' | 'error'>(() => (missed.value ? 'error' : 'ok'));

const statusDetail = computed(() => {
  const c = cron.value;
  if (!c) return '';
  const parts: string[] = [];
  if (c.recurring === false) parts.push(t('conversation.cron.oneShot'));
  if (typeof c.coalescedCount === 'number' && c.coalescedCount > 1) {
    parts.push(t('conversation.cron.coalesced', { n: c.coalescedCount }));
  }
  if (c.missedCount !== undefined) {
    parts.push(t('conversation.cron.missedCount', { n: c.missedCount }));
  }
  if (c.stale === true) parts.push(t('conversation.cron.finalDelivery'));
  return parts.join(' · ');
});

const headLabel = computed(() => {
  const parts = [title.value];
  if (schedule.value) parts.push(schedule.value);
  if (statusDetail.value) parts.push(statusDetail.value);
  return parts.join(' · ');
});

const headTooltip = computed(() => {
  const id = cron.value?.jobId;
  return id ? t('conversation.cron.job', { id }) : undefined;
});

const text = computed(() => props.text ?? '');
</script>

<template>
  <div
    class="cn cron-notice"
    :class="{ 'turn-anchor': !!turnId }"
    :data-turn-id="turnId"
    role="status"
  >
    <div class="cn-head" :class="statusKind" :title="headTooltip">
      <Icon name="clock" size="sm" class="cn-head-ico" aria-hidden="true" />
      <span class="cn-head-text">{{ headLabel }}</span>
    </div>
    <div v-if="text" class="cn-bubble">
      <span class="cn-prompt">{{ text }}</span>
    </div>
    <div v-if="createdAt" class="cn-meta">
      <MessageTime :time="createdAt" />
    </div>
  </div>
</template>

<style scoped>
.cn {
  margin: 0;
  margin-inline-start: auto;
  align-self: flex-end;
  width: fit-content;
  max-width: 78%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.cn-head {
  align-self: flex-end;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  padding: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.cn-head-ico {
  flex: none;
}
.cn-head.error .cn-head-ico {
  color: var(--color-danger);
}

.cn-bubble {
  box-sizing: border-box;
  max-width: 100%;
  padding: 10px 12px;
  background: var(--color-user-bubble-bg);
  border-radius: var(--radius-lg);
  color: var(--color-text);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cn-meta {
  margin-top: var(--space-1);
  padding: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
</style>
