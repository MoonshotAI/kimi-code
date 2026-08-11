<!-- apps/kimi-web/src/components/chat/tool-calls/BashTool.vue -->
<!-- Bash / shell tool: a terminal-flavoured quiet line. The row leads with the
     localized Run label, then the command itself in mono (CSS-truncated to the
     available width); expanding shows the full command echo plus the terminal
     output panel. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '../../../types';
import { parseArgRecord, str } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const command = computed(() => {
  const d = parseArgRecord(props.tool.arg);
  const cmd = str(d?.command) ?? str(d?.cmd) ?? str(d?.script);
  return (cmd ?? props.tool.arg.replace(/^·\s*/, '')).trim();
});

const isRunning = computed(() => props.tool.status === 'running');
const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
// Always expandable while there is a command to echo: output-less calls
// (mkdir, cd, …) still deserve a way to read the full command the row had to
// truncate — shell actions stay auditable from the transcript.
const canExpand = computed(() => hasOutput.value || isRunning.value || command.value.length > 0);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

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
    <span class="tl-mono">{{ command }}</span>
    <template #trailing>
      <span v-if="tool.timing" class="tl-chip">{{ tool.timing }}</span>
    </template>
    <template #body>
      <div class="cmd-echo">{{ command }}</div>
      <OutputPanel
        :lines="tool.output"
        :empty-text="isRunning ? t('tools.output.waiting') : t('tools.output.empty')"
      />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
/* Full command echo above the output — the row truncates, here it wraps. */
.cmd-echo {
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.6;
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-all;
  margin-bottom: var(--space-1);
}
</style>
