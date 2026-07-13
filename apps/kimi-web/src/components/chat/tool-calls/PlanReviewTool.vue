<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  FilePreviewRequest,
  PlanReviewStatus,
  ToolCall,
  ToolMedia,
} from '../../../types';
import Badge from '../../ui/Badge.vue';
import Card from '../../ui/Card.vue';
import Icon from '../../ui/Icon.vue';
import IconButton from '../../ui/IconButton.vue';
import Tooltip from '../../ui/Tooltip.vue';
import Markdown from '../Markdown.vue';

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
  openAgent: [toolCallId: string];
}>();

const { t } = useI18n();
const planReview = computed(() => props.tool.planReview!);
// Plans that still need attention or ended abnormally keep their body visible.
// The low-noise successful/dismissed history states start collapsed, but remain
// available through the explicit expand control.
const open = ref(
  planReview.value.status !== 'approved' && planReview.value.status !== 'dismissed',
);

const badgeVariant = computed<'neutral' | 'success' | 'warning' | 'danger'>(() => {
  switch (planReview.value.status) {
    case 'approved':
      return 'success';
    case 'pending':
    case 'revision_requested':
      return 'warning';
    case 'rejected':
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
});

const selectedApproach = computed(() => {
  if (planReview.value.status !== 'approved') return undefined;
  const selectedLabel = planReview.value.selectedLabel;
  if (selectedLabel === undefined) return undefined;
  return planReview.value.options?.find((option) => option.label === selectedLabel)?.label;
});

function statusLabel(status: PlanReviewStatus): string {
  return t(`approval.planHistory.status.${status}`);
}
</script>

<template>
  <Card
    class="plan-card"
    :class="{
      'is-pending': planReview.status === 'pending',
      'is-collapsed': !open,
    }"
  >
    <template #head>
      <div class="plan-head">
        <Icon class="plan-icon" name="file-text" size="md" />
        <span class="plan-title">{{ t('approval.planHistory.title') }}</span>
        <Badge :variant="badgeVariant" size="sm" dot>
          {{ statusLabel(planReview.status) }}
        </Badge>
        <Tooltip :text="open ? t('approval.planHistory.collapse') : t('approval.planHistory.expand')">
          <IconButton
            class="plan-toggle"
            size="sm"
            :label="open ? t('approval.planHistory.collapse') : t('approval.planHistory.expand')"
            :aria-expanded="open"
            @click="open = !open"
          >
            <Icon :name="open ? 'chevron-down' : 'chevron-right'" size="md" />
          </IconButton>
        </Tooltip>
      </div>
    </template>

    <div v-if="open" class="plan-body">
      <Tooltip v-if="planReview.path" :text="planReview.path">
        <div class="plan-path">{{ planReview.path }}</div>
      </Tooltip>

      <Markdown
        class="plan-markdown"
        :text="planReview.plan"
        :open-file="(target) => emit('openFile', target)"
      />

      <section v-if="planReview.options?.length" class="plan-section">
        <h4>{{ t('approval.planHistory.options') }}</h4>
        <div class="plan-options">
          <div v-for="option in planReview.options" :key="option.label" class="plan-option">
            <span class="plan-option-label">{{ option.label }}</span>
            <span v-if="option.description" class="plan-option-description">
              {{ option.description }}
            </span>
          </div>
        </div>
      </section>

      <dl v-if="selectedApproach || planReview.feedback" class="plan-result">
        <template v-if="selectedApproach">
          <dt>{{ t('approval.planHistory.selectedApproach') }}</dt>
          <dd>{{ selectedApproach }}</dd>
        </template>
        <template v-if="planReview.feedback">
          <dt>{{ t('approval.planHistory.feedback') }}</dt>
          <dd>{{ planReview.feedback }}</dd>
        </template>
      </dl>
    </div>
  </Card>
</template>

<style scoped>
.plan-card {
  width: 100%;
  margin: var(--space-2) 0;
}
.plan-card.is-pending.ui-card {
  border-color: var(--color-warning-bd);
}
.plan-card.is-pending :deep(.ui-card__head) {
  background: var(--color-warning-soft);
  border-bottom-color: var(--color-warning-bd);
}
.plan-card.is-collapsed :deep(.ui-card__head) {
  border-bottom: none;
}
.plan-card.is-collapsed :deep(.ui-card__body) {
  display: none;
}
.plan-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}
.plan-icon {
  flex: none;
  color: var(--color-text-muted);
}
.is-pending .plan-icon {
  color: var(--color-warning);
}
.plan-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font: var(--weight-medium) var(--text-sm)/var(--leading-normal) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-toggle {
  margin-left: auto;
}
.plan-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.plan-path {
  overflow: hidden;
  color: var(--color-text-muted);
  font: var(--text-xs)/var(--leading-normal) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-markdown {
  color: var(--color-text);
}
.plan-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-line);
}
.plan-section h4 {
  margin: 0;
  color: var(--color-text-muted);
  font: var(--weight-medium) var(--text-xs)/var(--leading-normal) var(--font-ui);
}
.plan-options {
  display: grid;
  gap: var(--space-2);
}
.plan-option {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}
.plan-option-label {
  color: var(--color-text);
  font: var(--weight-medium) var(--text-sm)/var(--leading-normal) var(--font-ui);
}
.plan-option-description {
  flex-basis: 100%;
  color: var(--color-text-muted);
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
}
.plan-result {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
}
.plan-result dt {
  color: var(--color-text-muted);
}
.plan-result dd {
  min-width: 0;
  margin: 0;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .plan-result {
    grid-template-columns: 1fr;
  }
}
</style>
