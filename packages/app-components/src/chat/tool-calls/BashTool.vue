<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton, Tooltip } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { ResolveDetachableTaskKey } from '@moonshot-ai/app-client/contracts';
import { argFallbackText, parseArgRecord, str } from '@moonshot-ai/app-components';
import { createCodeScrollbars } from '@moonshot-ai/app-markdown/lib/codeScrollbars';
import '@moonshot-ai/app-markdown/codeScrollbars.css';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import HighlightedCode from '../../HighlightedCode.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{ detach: [toolCallId: string] }>();

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const command = computed(() => {
  const d = parseArgRecord(props.tool.arg);
  const cmd = str(d?.command) ?? str(d?.cmd) ?? str(d?.script);
  return (cmd ?? argFallbackText(props.tool.arg)).trim();
});

const cwd = computed(() => {
  const d = parseArgRecord(props.tool.arg);
  return str(d?.cwd) ?? str(d?.workdir) ?? str(d?.directory) ?? '';
});

const panelTitle = computed(() => props.tool.name?.trim() || 'Bash');

const isRunning = computed(() => props.tool.status === 'running');
const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const outputText = computed(() => (props.tool.output ?? []).join('\n'));
const canExpand = computed(() => hasOutput.value || isRunning.value || command.value.length > 0);
const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true && canExpand.value);

const commandWrap = useHistoryState(`tool:${props.tool.id}:commandWrap`, false);
const outputWrap = useHistoryState(`tool:${props.tool.id}:outputWrap`, false);

const everOpened = ref(false);
watch(
  open,
  (v) => {
    if (v) everOpened.value = true;
  },
  { immediate: true },
);
const showCommand = computed(() => open.value || everOpened.value);

const boxesEl = ref<HTMLElement | null>(null);
let scrollbars: ReturnType<typeof createCodeScrollbars> | null = null;

watch(
  [showCommand, boxesEl, () => command.value.length > 0],
  ([opened, el]) => {
    if (!opened || !el) return;
    scrollbars ??= createCodeScrollbars(el, { viewports: '.bash-cmd, .op' });
    scrollbars.sync();
  },
  { flush: 'post', immediate: true },
);

onBeforeUnmount(() => {
  scrollbars?.destroy();
  scrollbars = null;
});

const resolveDetachableTask = inject(ResolveDetachableTaskKey, undefined);
const canDetach = computed(() => isRunning.value && resolveDetachableTask?.(props.tool.id) === true);

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="terminal" size="sm" /></template>
    <span class="tl-name">{{ t('tools.label.bash') }}</span>
    <span v-if="command && !open" class="tl-mono">{{ command }}</span>
    <template #trailing>
      <Tooltip v-if="canDetach" :text="t('tasks.toBackground')">
        <button
          class="tl-detach"
          :class="{ touch: mobile }"
          type="button"
          :aria-label="t('tasks.toBackground')"
          @click.stop="emit('detach', tool.id)"
        >
          <Icon name="pip" size="sm" aria-hidden="true" />
        </button>
      </Tooltip>
      <span v-if="tool.timing" class="tl-chip">{{ tool.timing }}</span>
    </template>
    <template #body>
      <div ref="boxesEl" class="bash-boxes" :class="{ 'bash-out-nowrap': !outputWrap }">
        <ToolPanel v-if="command" flush compact :title="panelTitle" :meta="cwd" :copy-text="command">
          <template #actions>
            <IconButton
              size="sm"
              :label="commandWrap ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
              :tooltip="commandWrap ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
              :pressed="commandWrap"
              @click.stop="commandWrap = !commandWrap"
            >
              <Icon :name="commandWrap ? 'text-wrap-disabled' : 'text-wrap'" size="sm" />
            </IconButton>
          </template>
          <div class="bash-cmd">
            <HighlightedCode v-if="showCommand" :code="command" path="command.bash" :framed="false" :wrap="commandWrap" />
          </div>
        </ToolPanel>
        <ToolPanel flush compact :title="t('tasks.fieldOutput')" :copy-text="hasOutput ? outputText : ''">
          <template v-if="hasOutput" #actions>
            <IconButton
              size="sm"
              :label="outputWrap ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
              :tooltip="outputWrap ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
              :pressed="outputWrap"
              @click.stop="outputWrap = !outputWrap"
            >
              <Icon :name="outputWrap ? 'text-wrap-disabled' : 'text-wrap'" size="sm" />
            </IconButton>
          </template>
          <OutputPanel
            :lines="tool.output"
            :empty-text="isRunning ? t('tools.output.waiting') : t('tools.output.empty')"
          />
        </ToolPanel>
      </div>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.bash-boxes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.bash-cmd {
  font-size: var(--code-font-size);
  line-height: 1.571;
  max-height: calc(8 * 1lh + var(--space-2));
  overflow: auto;
  overscroll-behavior: auto;
}
.bash-cmd :deep(.hl-body) {
  padding-top: 0;
}
.bash-cmd :deep(.hl-text) {
  padding-right: var(--space-3);
}
.bash-cmd,
.bash-boxes :deep(.op) {
  border-bottom-left-radius: var(--radius-md);
  border-bottom-right-radius: var(--radius-md);
}
.bash-boxes .bash-cmd :deep(.hl-code),
.bash-boxes :deep(.op) {
  font-size: var(--code-font-size);
}

.bash-boxes :deep(.op) {
  padding: 0 var(--space-3) var(--space-2);
  overscroll-behavior: auto;
}
.bash-boxes.bash-out-nowrap :deep(.op) {
  padding-right: 0;
  white-space: pre;
  word-break: normal;
}
.bash-boxes.bash-out-nowrap :deep(.op > div) {
  box-sizing: border-box;
  width: max-content;
  min-width: 100%;
  padding-right: var(--space-3);
}

.tl-detach {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
  flex: none;
}
.tl-detach:hover {
  color: var(--color-text);
}
.tl-detach:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.tl-detach.touch {
  margin-left: 14px;
}
.tl-detach.touch::after {
  content: '';
  position: absolute;
  inset: -14px;
}
</style>
