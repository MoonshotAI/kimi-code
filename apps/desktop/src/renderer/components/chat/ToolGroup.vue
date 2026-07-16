<!-- apps/kimi-web/src/components/chat/ToolGroup.vue -->
<script setup lang="ts">
import { computed, inject, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ToolCall from './ToolCall.vue';
import { toolStackKey, toolStackPosition } from '../chatTurnRendering';
import type { ToolStackItem } from '../chatTurnRendering';
import type { FilePreviewRequest, ToolMedia } from '../../types';
import { Icon, StatusDot } from '@moonshot-ai/web-ui';
import { formatCountNumber } from '@moonshot-ai/web-i18n';

const props = withDefaults(
  defineProps<{
    tools: ToolStackItem[];
    mobile?: boolean;
  }>(),
  { mobile: false },
);

const emit = defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
  openAgent: [toolCallId: string];
}>();

const open = ref(true);

const count = computed(() => props.tools.length);
const aggregateStatus = computed<'running' | 'error' | 'done'>(() => {
  if (props.tools.some((t) => t.tool.status === 'running')) return 'running';
  if (props.tools.some((t) => t.tool.status === 'error')) return 'error';
  return 'done';
});
const { t } = useI18n();

const countTitle = computed(() => {
  const key = count.value === 1 ? 'tools.group.countOne' : 'tools.group.countOther';
  return t(key, { number: formatCountNumber(count.value, t) });
});

const statusLabel = computed(() => {
  switch (aggregateStatus.value) {
    case 'running':
      return t('tools.group.running');
    case 'error':
      return t('tools.group.error');
    default:
      return t('tools.group.done');
  }
});

function toggle(): void {
  open.value = !open.value;
}

const pinScroll = inject<(el: HTMLElement, ms?: number) => void>('pinScroll', () => {});
const headEl = ref<HTMLElement | null>(null);

function onHeadClick(): void {
  toggle();
  const el = headEl.value;
  if (el) nextTick(() => pinScroll(el));
}
</script>

<template>
  <div class="tool-group" :class="{ open }">
    <button class="tool-group-head" ref="headEl" type="button" :aria-expanded="open" @click="onHeadClick">
      <StatusDot :status="aggregateStatus" />
      <Icon class="tg-ic" name="list" size="sm" />
      <span class="tg-title">{{ countTitle }}</span>
      <span class="tg-meta">· {{ statusLabel }}</span>
      <Icon class="tg-car" name="chevron-right" size="sm" />
    </button>
    <div class="tool-group-body" :class="{ open }" :inert="!open">
      <div class="tool-group-body-inner">
        <ToolCall
          v-for="(item, si) in tools"
          :key="toolStackKey(item)"
          :tool="item.tool"
          :mobile="mobile"
          :stack-position="toolStackPosition(si, tools.length)"
          @open-media="emit('openMedia', $event)"
          @open-file="emit('openFile', $event)"
          @open-agent="emit('openAgent', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.tool-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 11px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.tool-group-head:hover {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.tool-group-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}
.tool-group.open .tool-group-head {
  border-bottom: 0.5px solid var(--color-line-strong);
}
.tg-ic {
  color: var(--color-text-faint);
  flex: none;
}
.tg-title {
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.tg-meta {
  color: var(--color-text-faint);
}
.tg-car {
  margin-left: auto;
  color: var(--color-text-faint);
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.tool-group.open .tg-car {
  transform: rotate(90deg);
}
.tool-group-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.tool-group-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.tool-group-body-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

</style>
