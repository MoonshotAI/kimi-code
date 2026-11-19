<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import type { OpenMediaRequest } from '@moonshot-ai/app-core/client/types';
import type { ActivityItem } from '../../../chatTurnRendering';
import { useHistoryState } from '../../historyState';
import HistoryRow from '../../HistoryRow.vue';
import ThinkingBlock from '../../ThinkingBlock.vue';
import ToolCall from '../../ToolCall.vue';
import ToolDisclosure from '../ToolDisclosure.vue';
import type { BrowserRetryItem } from '../browserRetries';
import { BrowserToolContextKey } from '../browserToolContext';
import { browserToolGlyph, browserToolPresentation, browserToolReceipt } from '../browserToolPresentation';
import BrowserReceiptThumb from './BrowserReceiptThumb.vue';

const props = withDefaults(defineProps<{ item: BrowserRetryItem; mobile?: boolean }>(), { mobile: false });
const emit = defineEmits<{ openMedia: [payload: OpenMediaRequest]; detach: [toolCallId: string] }>();
const { t } = useI18n();
const contexts = inject(BrowserToolContextKey, undefined);
const historyState = inject(HistoryStateKey, undefined);
const context = computed(() => contexts?.value.get(props.item.tool) ?? {});
const presentation = computed(() => browserToolPresentation(props.item.tool, context.value, t));
const glyph = computed(() => browserToolGlyph(props.item.tool));
const receiptId = computed(() => browserToolReceipt(props.item.tool));
const calls = computed(() => props.item.attempts.filter((attempt) => attempt.kind === 'tool').length);
const open = useHistoryState(`tool:${props.item.tool.id}:retries-open`, false);

function attemptKey(attempt: ActivityItem): string {
  return attempt.kind === 'tool' ? `tool-${attempt.tool.id || attempt.sourceIndex}` : `thinking-${attempt.sourceIndex}`;
}

function attemptState(attempt: ActivityItem): Map<string, unknown> | undefined {
  if (historyState === undefined) return undefined;
  const key = `retry:${attemptKey(attempt)}`;
  const known = historyState.get(key);
  if (known instanceof Map) return known as Map<string, unknown>;
  const created = new Map<string, unknown>();
  historyState.set(key, created);
  return created;
}
</script>

<template>
  <ToolDisclosure class="browser-retry" status="ok" :open="open" expandable @toggle="open = !open">
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
      <span class="tl-pill brr-chip">
        <Icon name="refresh" size="sm" aria-hidden="true" />{{ t('tools.browser.retry.chip', { count: item.retries }) }}
      </span>
    </template>
    <template #body>
      <div v-if="open" class="brr-body">
        <div class="brr-caption">{{ t('tools.browser.retry.attempts', { count: calls }) }}</div>
        <template v-for="attempt in item.attempts" :key="attemptKey(attempt)">
          <component :is="attemptState(attempt) ? HistoryRow : 'div'" v-bind="attemptState(attempt) ? { state: attemptState(attempt) } : {}" class="brr-attempt">
            <ThinkingBlock
              v-if="attempt.kind === 'thinking'"
              :text="attempt.thinking"
              :mobile="mobile"
              :started-at="attempt.startedAt"
              :duration-ms="attempt.durationMs"
            />
            <ToolCall
              v-else
              :tool="attempt.tool"
              :mobile="mobile"
              @open-media="emit('openMedia', $event)"
              @detach="emit('detach', $event)"
            />
          </component>
        </template>
      </div>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.brr-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-05);
  color: var(--color-text-faint);
  background: var(--color-fill-2);
}
.brr-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-05);
}
.brr-caption {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.brr-attempt {
  min-width: 0;
}
</style>
