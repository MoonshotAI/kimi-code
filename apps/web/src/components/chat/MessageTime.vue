<!-- apps/kimi-web/src/components/chat/MessageTime.vue -->
<!-- Click-to-expand timestamp shown under a message bubble (a real user
     message or a cron-fired message). Collapsed: a compact form via
     formatMessageTime (today "HH:MM", yesterday "昨天 HH:MM", this year
     "MM-DD HH:MM", older "YYYY-MM-DD HH:MM"). Expanded on click: the full
     "YYYY-MM-DD HH:MM". One component so the time under a user message and a
     cron notice stays identical. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatMessageTime } from '../../lib/formatMessageTime';

const props = defineProps<{ time: string }>();

const { t } = useI18n();
const expanded = ref(false);

const full = computed(() => {
  const d = new Date(props.time);
  if (Number.isNaN(d.getTime())) return props.time;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
});

const display = computed(() =>
  expanded.value ? full.value : formatMessageTime(props.time, t('conversation.yesterday')),
);

function toggle(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <button type="button" class="msg-time" @click.stop="toggle">{{ display }}</button>
</template>

<style scoped>
.msg-time {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  box-sizing: border-box;
  padding: 2px 5px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font: inherit;
  font-size: var(--text-base);
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.12s, color 0.12s, background-color 0.12s;
  white-space: nowrap;
}
.msg-time:hover {
  opacity: 1;
  color: var(--color-accent);
  background: var(--hover);
}
</style>
