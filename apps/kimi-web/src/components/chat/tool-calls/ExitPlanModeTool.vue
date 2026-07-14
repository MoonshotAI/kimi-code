<!-- apps/kimi-web/src/components/chat/tool-calls/ExitPlanModeTool.vue -->
<!-- ExitPlanMode renders its plan as a markdown card instead of a raw output
     dump: the plan body arrives via ToolCall.plan (seeded from the preserved
     plan_review approval display, then settled from the structured
     plan_resolution display on the tool result — see
     exitPlanModePlanFromDisplay in messagesToTurns.ts). Approved,
     auto-approved and rejected plans all share this card, distinguished by
     the status badge; a rejection keeps the plan visible with its feedback
     underneath. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FilePreviewRequest, ToolCall, ToolMedia, ToolPlan } from '../../../types';
import { toolGlyph, toolLabel } from '../../../lib/toolMeta';
import ToolRow from '../ToolRow.vue';
import Markdown from '../Markdown.vue';
import Badge from '../../ui/Badge.vue';
import ToolOutputBlock from './ToolOutputBlock.vue';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
    toolDiffPanel?: boolean;
  }>(),
  { mobile: false, stackPosition: 'single', toolDiffPanel: false },
);

const emit = defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
  openToolDiff: [id: string];
}>();

const { t } = useI18n();

const plan = computed<ToolPlan | undefined>(() => props.tool.plan);
const hasPlanBody = computed(() => !!plan.value?.content);
const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => hasPlanBody.value || !!plan.value?.feedback || hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

const label = computed(() => toolLabel(props.tool.name));
const glyph = computed(() => toolGlyph(props.tool.name));

const badge = computed<{ text: string; variant: 'neutral' | 'success' | 'warning' | 'danger' } | null>(
  () => {
    switch (plan.value?.status) {
      case 'approved':
        return { text: t('approval.planCard.approved'), variant: 'success' };
      case 'auto_approved':
        return { text: t('approval.planCard.autoApproved'), variant: 'warning' };
      case 'rejected':
        return { text: t('approval.planCard.rejected'), variant: 'danger' };
      case 'revise':
        return { text: t('approval.planCard.revise'), variant: 'warning' };
      case 'pending':
        return { text: t('approval.planCard.pending'), variant: 'neutral' };
      default:
        return null;
    }
  },
);

function toggle(): void {
  if (canExpand.value) open.value = !open.value;
}

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status, props.tool.plan] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolRow
    :icon="glyph"
    :name="label"
    :time="tool.timing"
    :open="open"
    :expandable="canExpand"
    :stacked="stackPosition !== 'single'"
    :stack-position="stackPosition"
    @toggle="toggle"
  >
    <template #trailing>
      <Badge v-if="badge" :variant="badge.variant" size="sm">{{ badge.text }}</Badge>
      <span v-if="plan?.chosenOption" class="chip">{{ plan.chosenOption }}</span>
    </template>

    <div v-if="hasPlanBody" class="plan-body">
      <Markdown :text="plan!.content!" :open-file="(target: FilePreviewRequest) => emit('openFile', target)" />
    </div>

    <div v-if="plan?.feedback" class="plan-feedback">
      <span class="plan-feedback-label">{{ t('approval.planCard.feedback') }}</span>
      <span class="plan-feedback-text">{{ plan.feedback }}</span>
    </div>

    <!-- Defensive fallback: no plan card data at all (legacy transcript) —
         show the raw output like GenericTool would. -->
    <ToolOutputBlock v-if="!plan && hasOutput" :lines="tool.output" empty-text="Waiting for output…" />
  </ToolRow>
</template>

<style scoped>
.plan-body {
  max-height: 50vh;
  overflow-y: auto;
}

.plan-feedback {
  margin-top: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px dashed var(--color-line);
  font-family: var(--font-ui);
  white-space: pre-wrap;
}
.plan-feedback-label {
  display: block;
  color: var(--color-warning);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  margin-bottom: 2px;
}
.plan-feedback-text {
  color: var(--color-text);
  font-size: var(--text-sm);
}
</style>
