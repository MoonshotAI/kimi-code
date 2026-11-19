<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { ScrollArea } from '@moonshot-ai/app-ui';
import type { OpenMediaRequest } from '@moonshot-ai/app-core/client/types';
import type { ActivityItem } from '../../../chatTurnRendering';
import { BrowserReceiptReaderKey } from '../browserReceipts';
import { BrowserToolContextKey } from '../browserToolContext';
import { browserToolPresentation, browserToolReceipt, isBrowserTool } from '../browserToolPresentation';
import BrowserReceiptThumb from './BrowserReceiptThumb.vue';

const props = defineProps<{ items: ActivityItem[] }>();
const emit = defineEmits<{ openMedia: [payload: OpenMediaRequest] }>();
const { t } = useI18n();
const contexts = inject(BrowserToolContextKey, undefined);
const reader = inject(BrowserReceiptReaderKey, undefined);

const frames = computed(() => {
  if (reader === undefined) return [];
  const list: Array<{ key: string; sessionId: string; receiptId: string; caption: string }> = [];
  for (const item of props.items) {
    if (item.kind !== 'tool' || !isBrowserTool(item.tool)) continue;
    const receiptId = browserToolReceipt(item.tool);
    const context = contexts?.value.get(item.tool);
    if (receiptId === undefined || !context?.sessionId) continue;
    const { label, detail } = browserToolPresentation(item.tool, context, t);
    list.push({ key: item.tool.id, sessionId: context.sessionId, receiptId, caption: detail ? `${label} ${detail}` : label });
  }
  return list;
});
</script>

<template>
  <ScrollArea v-if="frames.length >= 2" class="brs" orientation="horizontal">
    <ol class="brs-list" role="list" :aria-label="t('tools.browser.detail.receiptStrip')">
      <li v-for="frame in frames" :key="frame.key" class="brs-item">
        <BrowserReceiptThumb
          :session-id="frame.sessionId"
          :receipt-id="frame.receiptId"
          variant="frame"
          :label="frame.caption"
          @open-media="emit('openMedia', $event)"
        />
        <span class="brs-caption">{{ frame.caption }}</span>
      </li>
    </ol>
  </ScrollArea>
</template>

<style scoped>
.brs {
  margin-bottom: var(--space-1);
}
.brs-list {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  padding: 0 0 var(--space-1);
  list-style: none;
}
.brs-item {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--space-1);
  min-width: var(--browser-receipt-frame-min-width);
}
.brs-caption {
  width: 0;
  min-width: 100%;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}
</style>
