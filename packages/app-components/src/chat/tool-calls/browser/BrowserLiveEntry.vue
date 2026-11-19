<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, Tooltip } from '@moonshot-ai/app-ui';
import type { ActivityItem } from '../../../chatTurnRendering';
import { BrowserLiveViewKey } from '../browserLive';
import { BrowserToolContextKey } from '../browserToolContext';
import { browserToolReceipt, browserToolTab, isBrowserTool } from '../browserToolPresentation';
import BrowserReceiptThumb from './BrowserReceiptThumb.vue';

const props = defineProps<{ items: ActivityItem[] }>();
const { t } = useI18n();
const liveView = inject(BrowserLiveViewKey, undefined);
const contexts = inject(BrowserToolContextKey, undefined);

const tools = computed(() => props.items.flatMap((item) => item.kind === 'tool' && isBrowserTool(item.tool) ? [item.tool] : []));

const sessionId = computed(() => {
  for (const tool of tools.value) {
    const id = contexts?.value.get(tool)?.sessionId;
    if (id) return id;
  }
  return undefined;
});

const state = computed(() => {
  const id = sessionId.value;
  return liveView === undefined || id === undefined ? null : liveView.state(id);
});

const hidden = computed(() => state.value !== null && !state.value.visible);

const agentId = computed(() => {
  const running = tools.value.findLast((tool) => tool.status === 'running');
  return (running ?? tools.value.at(-1))?.agentId;
});

const receiptId = computed(() => {
  const tabId = state.value?.tabId;
  for (let index = tools.value.length - 1; index >= 0; index--) {
    const tool = tools.value[index]!;
    if (tool.agentId !== agentId.value || browserToolTab(tool) !== tabId) continue;
    const id = browserToolReceipt(tool);
    if (id !== undefined) return id;
  }
  return undefined;
});

function show(): void {
  if (sessionId.value !== undefined) liveView?.show(sessionId.value);
}
</script>

<template>
  <span v-if="hidden && sessionId" class="ble">
    <BrowserReceiptThumb
      v-if="receiptId"
      :key="receiptId"
      variant="row"
      live
      :session-id="sessionId"
      :receipt-id="receiptId"
      :label="t('tools.browser.live.thumb')"
      @open-media="show"
    />
    <Tooltip :text="t('tools.browser.live.viewLabel')">
      <Button class="ble-view" variant="secondary" size="xs" :aria-label="t('tools.browser.live.viewLabel')" @click.stop="show">
        <Icon name="eye" size="sm" />{{ t('tools.browser.live.view') }}
      </Button>
    </Tooltip>
  </span>
</template>

<style scoped>
.ble {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  margin-block: calc(var(--space-05) * -1);
  animation: kimi-card-in var(--duration-base) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .ble {
    animation: none;
  }
}
</style>
