<!-- apps/kimi-web/src/components/chat/CronNotice.vue -->
<!-- In-transcript notice for a turn triggered by a scheduled reminder rather
     than a real user. It is styled to read like a user message — a right-
     aligned, max-width-capped bubble in the user-bubble colour — because a cron
     fire is semantically a message the user scheduled earlier. The bubble shows
     the title + the fired prompt in full, wrapping across lines (no truncation,
     no tooltip). Schedule / status / job id / fire time sit in a small meta row
     beneath the bubble, mirroring the meta row under a real user message; the
     fire time reuses the same <MessageTime> component as a user message so the
     two stay identical.

     Renders either as a standalone turn (pass turnId for the scroll anchor) or
     embedded inside an assistant turn's blocks — in both cases it takes the
     same text + cron data. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '../ui/Icon.vue';
import MessageTime from './MessageTime.vue';
import { humanizeCron } from '../../lib/cronHumanize';
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

const schedule = computed(() => {
  const expr = cron.value?.cron;
  return expr ? humanizeCron(expr, t) : '';
});

// A clean fire reads as "ok" (green ✓); a missed fire (skipped runs) as
// "error" (red ✗). Surfaced in the meta row below the bubble.
const statusKind = computed<'ok' | 'error'>(() => (missed.value ? 'error' : 'ok'));

// Fire-state flags (one-shot / coalesced / missed / final delivery); shown in
// the meta row when any apply.
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

const text = computed(() => props.text ?? '');
</script>

<template>
  <div
    class="cn cron-notice"
    :class="{ 'turn-anchor': !!turnId }"
    :data-turn-id="turnId"
    role="status"
  >
    <div class="cn-bubble">
      <span class="cn-title">{{ title }}</span>
      <template v-if="text"> <span class="cn-prompt">{{ text }}</span></template>
    </div>
    <div class="cn-meta">
      <Icon name="clock" size="sm" class="cn-meta-ico" aria-hidden="true" />
      <span v-if="schedule" class="cn-meta-item">{{ schedule }}</span>
      <span v-if="statusDetail" class="cn-meta-item">{{ statusDetail }}</span>
      <span class="cn-status" :class="statusKind" :aria-label="statusKind">
        <Icon v-if="statusKind === 'ok'" name="check" size="sm" />
        <Icon v-else name="close" size="sm" />
      </span>
      <span
        v-if="cron?.jobId"
        class="cn-meta-item cn-id"
        :title="t('conversation.cron.job', { id: cron.jobId })"
      >{{ cron.jobId }}</span>
      <MessageTime v-if="createdAt" :time="createdAt" />
    </div>
  </div>
</template>

<style scoped>
.cn {
  margin: 0;
  align-self: flex-end;
  max-width: 78%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* Mirrors the user bubble (.u-bub): accent fill + border, rounded with one
   small corner, soft shadow. The prompt is shown in full and wraps across
   lines (long tokens break) — no truncation. */
.cn-bubble {
  box-sizing: border-box;
  max-width: 100%;
  padding: 8px 14px;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl);
  box-shadow: var(--shadow-xs);
  color: var(--color-text);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cn-title {
  font-weight: var(--weight-medium);
}

/* Meta row under the bubble, sized to match the user message's meta row. */
.cn-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.cn-meta-ico {
  flex: none;
  color: var(--color-text-faint);
}
.cn-meta-item {
  white-space: nowrap;
}
.cn-status {
  display: inline-flex;
  align-items: center;
}
.cn-status.ok {
  color: var(--color-success);
}
.cn-status.error {
  color: var(--color-danger);
}
</style>
