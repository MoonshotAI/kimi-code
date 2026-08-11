<!-- Read-only ExitPlanMode record. Pending decisions stay in ApprovalCard;
     this row keeps the submitted plan and final review visible in history. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Markdown } from '@moonshot-ai/app-markdown';
import type { FilePreviewRequest, ToolCall } from '../../../types';
import { toolGlyph, toolLabel } from '../../../lib/toolMeta';
import OutputPanel from './OutputPanel.vue';
import ToolDisclosure from './ToolDisclosure.vue';

const props = defineProps<{ tool: ToolCall; mobile?: boolean }>();
const emit = defineEmits<{ openFile: [target: FilePreviewRequest] }>();
const { t } = useI18n();

const open = ref(props.tool.defaultExpanded === true);
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
  emit('openFile', { path: path.value, content: plan.value?.plan });
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
    <template #trailing>
      <span v-if="tool.timing" class="tl-chip">{{ tool.timing }}</span>
    </template>
    <template #body>
      <button
        v-if="path"
        type="button"
        class="plan-path"
        :title="path"
        @click="openPlanFile"
      >{{ path }}</button>
      <div v-if="plan" class="plan-content">
        <Markdown :text="plan.plan" :open-file="(target) => emit('openFile', target)" />
      </div>
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
      <OutputPanel
        v-if="!plan"
        :lines="tool.output"
        :empty-text="t('tools.output.empty')"
      />
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
  margin: 0 0 var(--space-2);
  padding: 0;
  overflow: hidden;
  border: none;
  background: transparent;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
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
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
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
