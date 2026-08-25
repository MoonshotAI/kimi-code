<!-- Fallback renderer for tools without a bespoke line (cron, skill runs, and
     anything new the daemon emits): the registry glyph + localized label + a
     summary of the key argument; expanding shows the full argument and the
     raw output panel. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FilePreviewRequest, OpenMediaRequest, ToolCall } from '../../../types';
import { toolChip, toolGlyph, toolLabel, toolSummary } from '../../../lib/toolMeta';
import ToolDisclosure from './ToolDisclosure.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  openFile: [target: FilePreviewRequest];
}>();

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const label = computed(() => toolLabel(props.tool.name));
const glyph = computed(() => toolGlyph(props.tool.name));
const summary = computed(() => toolSummary(props.tool.name, props.tool.arg));
const summaryFull = computed(() => toolSummary(props.tool.name, props.tool.arg, true));
const chip = computed(() =>
  toolChip({
    name: props.tool.name,
    arg: props.tool.arg,
    output: props.tool.output,
    timing: props.tool.timing,
    status: props.tool.status,
  }),
);

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
// Expand only when there is something to reveal: real output, or an argument
// long enough that the row had to clip it. A short arg with no output would
// open an empty body showing only "Waiting for output…" on a settled call.
const canExpand = computed(
  () => hasOutput.value || (Boolean(summaryFull.value) && summaryFull.value !== summary.value),
);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status, props.tool.name] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><span class="gl" v-html="glyph" /></template>
    <span class="tl-name">{{ label }}</span>
    <span v-if="summary" class="tl-dim">{{ summary }}</span>
    <template #trailing>
      <span v-if="chip" class="tl-chip">{{ chip }}</span>
      <span v-else-if="tool.timing" class="tl-chip">{{ tool.timing }}</span>
    </template>
    <template #body>
      <div v-if="summaryFull && summaryFull !== summary" class="arg-full">{{ summaryFull }}</div>
      <OutputPanel
        :lines="tool.output"
        :empty-text="status === 'running' ? t('tools.output.waiting') : t('tools.output.empty')"
      />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.gl {
  display: inline-flex;
  align-items: center;
}
/* The complete argument, when the row had to clip it. */
.arg-full {
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
