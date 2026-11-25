<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { useAutoReviewHint } from '@moonshot-ai/app-client/composables';
import { computerUseArgFields, toolChip, toolGlyph, toolLabel, toolSummary } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const label = computed(() => toolLabel(props.tool.name, props.tool.arg));
const glyph = computed(() => toolGlyph(props.tool.name));
const summary = computed(() => toolSummary(props.tool.name, props.tool.arg));
const summaryFull = computed(() => toolSummary(props.tool.name, props.tool.arg, true));
const argFields = computed(() => computerUseArgFields(props.tool.name, props.tool.arg));
const chip = computed(() =>
  toolChip({
    name: props.tool.name,
    arg: props.tool.arg,
    output: props.tool.output,
    timing: props.tool.timing,
    status: props.tool.status,
  }),
);

const reviewHint = useAutoReviewHint(() => props.tool.autoReviewing === true);

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(
  () => hasOutput.value || argFields.value.length > 0 || (Boolean(summaryFull.value) && summaryFull.value !== summary.value),
);
const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true && canExpand.value);

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
    <span v-if="reviewHint" class="tl-faint">{{ t('tools.activity.autoReviewing') }}</span>
    <span v-else-if="chip" class="tl-faint">{{ chip }}</span>
    <span v-else-if="tool.timing" class="tl-faint">{{ tool.timing }}</span>
    <template #body>
      <ToolPanel scroll>
        <dl v-if="argFields.length > 0" class="gt-fields">
          <template v-for="field in argFields" :key="field.key">
            <dt>{{ field.label }}</dt>
            <dd>{{ field.value }}</dd>
          </template>
        </dl>
        <div v-if="summaryFull && summaryFull !== summary" class="gt-args">{{ summaryFull }}</div>
        <OutputPanel
          :lines="tool.output"
          :empty-text="reviewHint ? t('tools.activity.autoReviewing') : status === 'running' ? t('tools.output.waiting') : t('tools.output.empty')"
        />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.gt-args {
  margin-bottom: var(--space-2);
  color: var(--color-text-muted);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.gt-fields {
  display: grid;
  grid-template-columns: fit-content(40%) minmax(0, 1fr);
  gap: var(--space-1) var(--space-4);
  margin: 0 0 var(--space-2);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
}
.gt-fields dt {
  color: var(--color-text-muted);
  user-select: none;
}
.gt-fields dd {
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.gl {
  display: inline-flex;
  align-items: center;
}
</style>
