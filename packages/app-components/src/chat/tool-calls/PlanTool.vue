<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { Markdown } from '@moonshot-ai/app-markdown';
import { Tooltip } from '@moonshot-ai/app-ui';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { toolGlyph, toolLabel } from '../../lib/toolMeta';
import OutputPanel from './OutputPanel.vue';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';

const props = withDefaults(
  defineProps<{ tool: ToolCall; mobile?: boolean; resolveFilePath?: (path: string) => { path: string; assumed: boolean } | null; resolveImage?: (src: string) => Promise<string> }>(),
  { mobile: false, resolveFilePath: undefined, resolveImage: undefined },
);
const { t } = useI18n();

const panelApi = inject(panelApiKey);

const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true);
const plan = computed(() => props.tool.plan);
const path = computed(() => plan.value?.path ?? props.tool.planPath);
const canExpand = computed(
  () => plan.value !== undefined || path.value !== undefined || (props.tool.output?.length ?? 0) > 0,
);
const reviewLabel = computed(() => {
  const state = plan.value?.review?.state;
  return state ? t(`tools.plan.review.${state}`) : undefined;
});

function openPlanFile(): void {
  if (!path.value) return;
  panelApi?.openFile({ path: path.value, content: plan.value?.plan });
}
</script>

<template>
  <ToolDisclosure
    :status="tool.status"
    :open="open"
    :expandable="canExpand"
    @toggle="open = !open"
  >
    <template #leading><span class="plan-glyph" v-html="toolGlyph(tool.name)" /></template>
    <span class="tl-name">{{ toolLabel(tool.name) }}</span>
    <span v-if="reviewLabel" class="tl-faint">{{ reviewLabel }}</span>
    <span v-if="tool.timing" class="tl-faint">{{ tool.timing }}</span>
    <template #body>
      <ToolPanel scroll :copy-text="plan?.plan ?? ''">
        <template v-if="path" #head>
          <Tooltip :text="path">
            <button type="button" class="plan-path" :data-file-path="path" @click.stop="openPlanFile">{{ path }}</button>
          </Tooltip>
        </template>
        <div v-if="plan" class="plan-content">
          <Markdown :text="plan.plan" :open-file="panelApi?.openFile" :resolve-file-path="props.resolveFilePath" :resolve-image="props.resolveImage" />
        </div>
        <OutputPanel v-else :lines="tool.output" :empty-text="t('tools.output.empty')" />
      </ToolPanel>
      <div v-if="plan?.review?.selectedOption || plan?.review?.feedback" class="plan-review">
        <div v-if="plan.review.selectedOption">
          <span class="review-label">{{ t('tools.plan.selectedOption') }}</span>
          <span>{{ plan.review.selectedOption }}</span>
        </div>
        <div v-if="plan.review.feedback">
          <span class="review-label">{{ t('tools.plan.feedback') }}</span>
          <span class="review-feedback">{{ plan.review.feedback }}</span>
        </div>
      </div>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.plan-glyph {
  display: inline-flex;
  align-items: center;
}
.plan-path {
  display: block;
  max-width: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.plan-path:hover {
  text-decoration: underline;
}
.plan-path:focus-visible {
  outline: none;
  border-radius: var(--radius-xs);
  box-shadow: var(--p-focus-ring);
}
.plan-content {
  color: var(--color-text);
}
.plan-review {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.plan-review > div {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.review-label {
  flex: none;
  color: var(--color-text-faint);
}
.review-feedback {
  white-space: pre-wrap;
}
</style>
