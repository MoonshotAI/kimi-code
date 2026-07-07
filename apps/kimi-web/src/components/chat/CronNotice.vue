<!-- apps/kimi-web/src/components/chat/CronNotice.vue -->
<!-- In-transcript card for a turn triggered by a scheduled reminder rather
     than a real user. A left accent bar + soft tint make it read as one event
     card distinct from the chat around it; the header carries the glyph, title,
     a humanized schedule ("Every 5 minutes") and a dimmed job id; the fired
     prompt is collapsed to its first line with an expand toggle so long prompts
     don't swamp the transcript. stale/missed fires switch the accent to warning.

     Renders either as a standalone turn (pass turnId for the scroll anchor) or
     embedded inside an assistant turn's blocks (a cron steered into an in-flight
     turn) — in both cases it takes the same text + cron data. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '../ui/Icon.vue';
import { humanizeCron, collapsePrompt } from '../../lib/cronHumanize';
import type { CronTurnData } from '../../types';

const props = defineProps<{
  text: string;
  cron?: CronTurnData;
  /** Scroll-anchor id for a standalone cron turn; omitted when embedded in an
   *  assistant turn's blocks (the assistant turn already carries the anchor). */
  turnId?: string;
}>();

const { t } = useI18n();

const cron = computed(() => props.cron);
const missed = computed(() => cron.value?.missedCount !== undefined);
const warning = computed(() => cron.value?.stale === true || missed.value);

const title = computed(() =>
  missed.value ? t('conversation.cron.missed') : t('conversation.cron.fired'),
);

const schedule = computed(() => {
  const expr = cron.value?.cron;
  return expr ? humanizeCron(expr, t) : '';
});

// Status-only metadata: schedule + job id already live in the header, so this
// line surfaces only the fire-state flags (one-shot / coalesced / missed /
// final delivery) and is hidden when none apply.
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

const expanded = ref(false);
const text = computed(() => props.text ?? '');
const collapsed = computed(() => collapsePrompt(text.value));
const hasMore = computed(() => collapsed.value.hasMore);
const shownText = computed(() => (expanded.value ? text.value : collapsed.value.text));
</script>

<template>
  <div
    class="cron-notice"
    :class="{ 'is-warning': warning, 'turn-anchor': !!turnId }"
    :data-turn-id="turnId"
    role="status"
  >
    <div class="cn-head">
      <span class="cn-icon" aria-hidden="true"><Icon name="clock" size="sm" /></span>
      <span class="cn-title">{{ title }}</span>
      <span v-if="schedule" class="cn-badge">{{ schedule }}</span>
      <span
        v-if="cron?.jobId"
        class="cn-job"
        :title="t('conversation.cron.job', { id: cron.jobId })"
      >{{ cron.jobId }}</span>
    </div>

    <div v-if="statusDetail" class="cn-status">{{ statusDetail }}</div>

    <div v-if="text" class="cn-prompt">{{ shownText }}</div>
    <button
      v-if="text && hasMore"
      type="button"
      class="cn-toggle"
      @click="expanded = !expanded"
    >{{ expanded ? t('conversation.cron.collapse') : t('conversation.cron.expand') }}</button>
  </div>
</template>

<style scoped>
.cron-notice {
  display: block;
  align-self: stretch;
  border-left: 3px solid var(--color-accent);
  background: var(--color-accent-soft);
  border-radius: 8px;
  padding: 8px 12px;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
}
.cron-notice.is-warning {
  border-left-color: var(--color-warning);
  background: var(--color-warning-soft);
}
.cn-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.cn-icon {
  display: inline-flex;
  flex: none;
  color: var(--color-accent);
}
.cron-notice.is-warning .cn-icon {
  color: var(--color-warning);
}
.cn-title {
  font-weight: 600;
}
.cn-badge {
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-muted);
  border: 1px solid var(--color-accent-bd);
  border-radius: 999px;
  padding: 0 8px;
}
.cn-job {
  margin-left: auto;
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-muted);
  opacity: 0.7;
}
.cn-status {
  margin-top: 4px;
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-muted);
}
.cn-prompt {
  margin-top: 6px;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.cn-toggle {
  margin-top: 4px;
  padding: 0;
  border: 0;
  background: none;
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
  color: var(--color-accent);
  cursor: pointer;
}
.cn-toggle:hover {
  text-decoration: underline;
}
</style>
