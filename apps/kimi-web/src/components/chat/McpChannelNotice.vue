<!-- apps/kimi-web/src/components/chat/McpChannelNotice.vue -->
<!-- In-transcript notice for a turn triggered by an MCP server pushing a
     message (e.g. a Discord bridge) rather than a real user. Styled like
     CronNotice: a right-aligned, max-width-capped bubble in the user-bubble
     colour, since the push is semantically a message from outside Kimi Code
     that woke the agent. Shows the source server + the pushed text in full;
     the fire time reuses the same <MessageTime> component as a user
     message. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import MessageTime from './MessageTime.vue';
import type { McpChannelTurnData } from '../../types';

const props = defineProps<{
  text: string;
  mcpChannel?: McpChannelTurnData;
  /** Scroll-anchor id for the standalone turn. */
  turnId?: string;
  /** ISO timestamp of when the message was pushed (the turn's createdAt). */
  createdAt?: string;
}>();

const { t } = useI18n();

const title = computed(() =>
  t('conversation.mcpChannel.received', { server: props.mcpChannel?.server ?? '' }),
);

const text = computed(() => props.text ?? '');
</script>

<template>
  <div class="mcn cron-notice" :class="{ 'turn-anchor': !!turnId }" :data-turn-id="turnId" role="status">
    <div class="mcn-bubble">
      <span class="mcn-title">{{ title }}</span>
      <template v-if="text"> <span class="mcn-text">{{ text }}</span></template>
    </div>
    <div class="mcn-meta">
      <span v-if="mcpChannel?.chatId" class="mcn-meta-item">{{ mcpChannel.chatId }}</span>
      <MessageTime v-if="createdAt" :time="createdAt" />
    </div>
  </div>
</template>

<style scoped>
.mcn {
  margin: 0;
  align-self: flex-end;
  max-width: 78%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* Mirrors the user bubble (.u-bub) and CronNotice's .cn-bubble. */
.mcn-bubble {
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
.mcn-title {
  font-weight: var(--weight-medium);
}

.mcn-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.mcn-meta-item {
  white-space: nowrap;
}
</style>
