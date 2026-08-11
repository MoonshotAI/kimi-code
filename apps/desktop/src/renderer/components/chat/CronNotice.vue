<!-- apps/web/src/components/chat/CronNotice.vue -->
<!-- In-transcript notice for a turn triggered by a scheduled reminder rather
     than a real user. It reads like a user message with a provenance label:
     one small faint line ABOVE the bubble (clock icon + title + schedule +
     fire-state flags, " · "-joined, right-aligned like the bubble),
     then the fired prompt in a right-aligned, max-width-capped bubble in the
     user-bubble colour (shown in full, wrapping across lines — no truncation).
     The label shows the raw cron expression verbatim (humanized renderings
     read mechanically); the job id stays out of sight in the label's hover
     tooltip. The only thing under the bubble is the fire time, rendered with
     the same <MessageTime> component as a real user message so the two stay
     identical.

     Renders either as a standalone turn (pass turnId for the scroll anchor) or
     embedded inside an assistant turn's blocks — in both cases it takes the
     same text + cron data. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import MessageTime from './MessageTime.vue';
import type { CronTurnData } from '../../types';

const props = defineProps<{
  text: string;
  cron?: CronTurnData;
  /** Scroll-anchor id for a standalone cron turn; omitted when embedded in an
   *  assistant turn's blocks (the assistant turn already carries the anchor). */
  turnId?: string;
  /** ISO timestamp of when the cron fired (the turn's createdAt). Omitted for
   *  the embedded-in-assistant case, which has no turn of its own. */
  createdAt?: string;
}>();

const { t } = useI18n();

const cron = computed(() => props.cron);
const missed = computed(() => cron.value?.missedCount !== undefined);

const title = computed(() =>
  missed.value ? t('conversation.cron.missed') : t('conversation.cron.fired'),
);

// The schedule label is the raw cron expression, shown verbatim. Skipped for
// one-shots: the pinned fire date is redundant next to the notice's own fire
// time, and the one-shot flag already says what kind of job it was.
const schedule = computed(() => {
  const c = cron.value;
  if (!c?.cron || c.recurring === false) return '';
  return c.cron;
});

// A missed fire (skipped runs) tints the label icon red; a clean fire stays
// the same faint grey as the rest of the transcript's meta text.
const statusKind = computed<'ok' | 'error'>(() => (missed.value ? 'error' : 'ok'));

// Fire-state flags (one-shot / coalesced / missed / final delivery), appended
// to the label when any apply.
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

// The single visible line above the bubble: title · schedule · flags.
const headLabel = computed(() => {
  const parts = [title.value];
  if (schedule.value) parts.push(schedule.value);
  if (statusDetail.value) parts.push(statusDetail.value);
  return parts.join(' · ');
});

// Hover tooltip on the label carries the job id, keeping machine detail
// reachable without cluttering the transcript.
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
/* Right-aligned column capped like the user bubble: the label, the bubble and
   the fire time all snap to its right edge. */
.cn {
  margin: 0;
  align-self: flex-end;
  max-width: 78%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* Provenance label above the bubble: small and faint so it reads as context
   for the bubble, not as message content. */
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

/* Mirrors the user bubble (.u-bub): neutral BubbleGray fill, uniform
   radius, no border, no shadow. The prompt is shown in full and wraps across
   lines (long tokens break) — no truncation. */
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

/* Fire time under the bubble — same spot as a real user message's meta row. */
.cn-meta {
  margin-top: var(--space-1);
  padding: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
</style>
