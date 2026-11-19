<script setup lang="ts">
import { computed, inject, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { OpenMediaRequest, ToolCall } from '@moonshot-ai/app-core/client/types';
import { useHistoryState } from '../historyState';
import { BrowserToolContextKey } from './browserToolContext';
import { browserToolGlyph, browserToolPresentation, browserToolReceipt } from './browserToolPresentation';
import { browserToolView } from './browserToolView';
import ToolDisclosure from './ToolDisclosure.vue';
import BrowserToolDetails from './browser/BrowserToolDetails.vue';
import BrowserReceiptThumb from './browser/BrowserReceiptThumb.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });
const emit = defineEmits<{ openMedia: [payload: OpenMediaRequest] }>();
const { t } = useI18n();
const contexts = inject(BrowserToolContextKey, undefined);
const context = computed(() => contexts?.value.get(props.tool) ?? {});
const presentation = computed(() => browserToolPresentation(props.tool, context.value, t));
const glyph = computed(() => browserToolGlyph(props.tool));
const receiptId = computed(() => browserToolReceipt(props.tool));
const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true);
const view = computed(() => open.value ? browserToolView(props.tool, context.value) : undefined);
watch(() => props.tool.defaultExpanded, (expanded) => {
  if (expanded) open.value = true;
});
</script>

<template>
  <ToolDisclosure :status="presentation.status" :open="open" expandable @toggle="open = !open">
    <template #leading><Icon :name="glyph.icon" size="sm" /></template>
    <span :class="glyph.quiet ? 'tl-chip' : 'tl-name'">{{ presentation.label }}</span>
    <span v-if="presentation.detail" :class="glyph.quiet ? 'tl-faint' : 'tl-dim'">{{ presentation.detail }}</span>
    <template #trailing>
      <BrowserReceiptThumb
        v-if="receiptId && context.sessionId"
        variant="row"
        :session-id="context.sessionId"
        :receipt-id="receiptId"
        :label="t('tools.browser.detail.receiptOpen')"
        @open-media="emit('openMedia', $event)"
      />
      <span v-if="tool.timing" class="tl-chip">{{ tool.timing }}</span>
    </template>
    <template #body>
      <BrowserToolDetails
        v-if="open"
        :tool="tool"
        :session-id="context.sessionId"
        :view="view"
        :running="presentation.status === 'running'"
        @open-media="emit('openMedia', $event)"
      />
    </template>
  </ToolDisclosure>
</template>
