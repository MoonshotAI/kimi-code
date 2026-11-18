<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { notificationStatus } from '@moonshot-ai/app-core/client';
import type { TaskNotification } from '@moonshot-ai/app-core/client/types';
import AskAnswerReceipt from './AskAnswerReceipt.vue';
import ToolDisclosure from './tool-calls/ToolDisclosure.vue';
import { useHistoryState } from './historyState';

const props = defineProps<{ notification: TaskNotification; detailKey: string }>();

const { t } = useI18n();
const open = useHistoryState(`notification:question:${props.detailKey}:open`, true);

const state = computed<'answered' | 'dismissed' | 'cancelled'>(() => {
  if (notificationStatus(props.notification) === 'killed') return 'cancelled';
  return Object.keys(props.notification.questionAnswer?.answers ?? {}).length > 0
    ? 'answered'
    : 'dismissed';
});
const rows = computed(() =>
  Object.entries(props.notification.questionAnswer?.answers ?? {}).map(([question, answer]) => ({
    question,
    answer: answerText(answer),
  })),
);

function answerText(value: string | true): string {
  if (value === true) return t('tools.ask.answered');
  return value.trim() === '' ? t('tools.ask.unanswered') : value;
}
</script>

<template>
  <AskAnswerReceipt
    v-if="state === 'answered'"
    :rows="rows"
    :open="open"
    @toggle="open = !open"
  />
  <ToolDisclosure
    v-else
    :status="state === 'cancelled' ? 'cancelled' : 'ok'"
    :open="false"
    :expandable="false"
  >
    <template #leading><Icon name="help-circle" size="sm" /></template>
    <span class="tl-name">{{ t(`conversation.notification.question.${state}`) }}</span>
  </ToolDisclosure>
</template>
