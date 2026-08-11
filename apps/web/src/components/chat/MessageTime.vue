<!-- apps/kimi-web/src/components/chat/MessageTime.vue -->
<!-- Static timestamp shown under a message bubble (a real user message or a
     cron-fired message), via formatMessageTime (today "HH:MM", yesterday
     "昨天 HH:MM", this year "MM-DD HH:MM", older "YYYY-MM-DD HH:MM"). One
     component so the time under a user message and a cron notice stays
     identical. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatMessageTime } from '@moonshot-ai/app-core/lib';

const props = defineProps<{ time: string }>();

const { t } = useI18n();

const display = computed(() => formatMessageTime(props.time, t('conversation.yesterday')));
</script>

<template>
  <span class="msg-time">{{ display }}</span>
</template>

<style scoped>
.msg-time {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  box-sizing: border-box;
  padding: 2px 5px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: 1;
  opacity: 0.7;
  white-space: nowrap;
}
</style>
