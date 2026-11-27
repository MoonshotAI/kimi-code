<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Markdown } from '@moonshot-ai/app-markdown';
import { StatusDot } from '@moonshot-ai/app-ui';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import { LatestNotifyToolCallIdKey } from '@moonshot-ai/app-client/contracts';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { formatMessageTime, parseNotifyUserArgs } from '@moonshot-ai/app-core/lib';
import ToolDisclosure from './ToolDisclosure.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean; resolveFilePath?: (path: string) => { path: string; assumed: boolean } | null; resolveImage?: (src: string) => Promise<string> }>(), { mobile: false, resolveFilePath: undefined, resolveImage: undefined });

const { t } = useI18n();
const panelApi = inject(panelApiKey);

const update = computed(() => parseNotifyUserArgs(props.tool.arg));
const title = computed(() => update.value.title || t('tools.notifyUser.posting'));
const expandable = computed(() => update.value.message.length > 0);
const time = computed(() => {
  const at = props.tool.startedAt;
  if (at === undefined || !Number.isFinite(Date.parse(at))) return '';
  return formatMessageTime(at, t('conversation.yesterday'));
});

const openStateKey = computed(() => `tool:${props.tool.id}:open`);
const historyState = inject(HistoryStateKey, undefined);
const latestNotifyToolCallId = inject(LatestNotifyToolCallIdKey, undefined);
const isLatest = computed(() => latestNotifyToolCallId?.value === props.tool.id);
const userChoice = ref<boolean | undefined>(
  historyState?.has(openStateKey.value) ? (historyState.get(openStateKey.value) as boolean) : undefined,
);
const open = computed<boolean>({
  get: () => userChoice.value ?? isLatest.value,
  set: (value) => {
    userChoice.value = value;
    historyState?.set(openStateKey.value, value);
  },
});
</script>

<template>
  <ToolDisclosure
    class="progress-row"
    :status="tool.status"
    :open="open"
    :expandable="expandable"
    @toggle="open = !open"
  >
    <template #leading><StatusDot status="unread" ring="halo" /></template>
    <span class="pg-title">{{ title }}</span>
    <template #trailing>
      <span v-if="time" class="tl-chip pg-time">{{ time }}</span>
    </template>
    <template #body>
      <div class="pg-body">
        <Markdown :text="update.message" :state-key="`notify:${tool.id}`" :open-file="panelApi?.openFile" :resolve-file-path="props.resolveFilePath" :resolve-image="props.resolveImage" />
      </div>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.pg-title {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pg-time {
  font-variant-numeric: tabular-nums;
}
.pg-body {
  color: var(--color-text);
}
.pg-body :deep(.markdown-renderer > .node-slot:first-child) {
  padding-top: 0;
}
</style>
