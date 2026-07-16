<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppGoal } from '../../api/types';
import { Button, Card, Icon } from '@moonshot-ai/web-ui';
import { useConfirmDialog } from '../../composables/useConfirmDialog';
import { formatTokens } from '../../lib/formatTokens';

const props = defineProps<{ goal: AppGoal; forceExpanded?: number }>();
const emit = defineEmits<{ controlGoal: [action: 'pause' | 'resume' | 'cancel'] }>();

const { t } = useI18n();
const { confirm } = useConfirmDialog();

const expanded = ref(false);

watch(
  () => props.forceExpanded,
  () => {
    if (props.forceExpanded !== undefined) expanded.value = true;
  },
);

const tokenPct = computed(() => {
  const budget = props.goal.budget.tokenBudget;
  if (!budget || budget <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((props.goal.tokensUsed / budget) * 100)));
});

function goalStatusLabel(status: AppGoal['status']): string {
  switch (status) {
    case 'active': return t('status.goalStatusActive');
    case 'paused': return t('status.goalStatusPaused');
    case 'blocked': return t('status.goalStatusBlocked');
    case 'complete': return t('status.goalStatusComplete');
  }
}

function formatMs(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min <= 0) return `${rem}s`;
  if (min < 60) return `${min}m ${rem}s`;
  const hour = Math.floor(min / 60);
  return `${hour}h ${min % 60}m`;
}

async function onCancel(): Promise<void> {
  const confirmed = await confirm({
    title: t('status.goalCancel'),
    message: t('status.goalCancelConfirm'),
    confirmLabel: t('status.goalCancelConfirmYes'),
    cancelLabel: t('status.goalCancelConfirmNo'),
    variant: 'danger',
  });
  if (confirmed) emit('controlGoal', 'cancel');
}
</script>

<template>
  <Card class="goal-strip" :class="{ expanded }">
    <template #head>
      <button class="goal-row" type="button" @click="expanded = !expanded">
        <Icon class="goal-icon" name="target" size="md" />
        <span class="goal-kicker">{{ t('status.goalLabel') }}</span>
        <span class="goal-objective" :class="{ 'expanded-hidden': expanded }">{{ goal.objective }}</span>
        <span class="goal-status" :class="`goal-status--${goal.status}`">
          {{ goalStatusLabel(goal.status) }}
        </span>
        <span v-if="goal.budget.tokenBudget !== null" class="goal-progress" aria-hidden="true">
          <span class="goal-progress-fill" :style="{ width: `${tokenPct}%` }"></span>
        </span>
        <Icon class="goal-chevron" :class="{ open: expanded }" name="chevron-right" size="md" />
      </button>
    </template>

    <template #default>
      <div class="goal-full">{{ goal.objective }}</div>
      <div v-if="goal.completionCriterion" class="goal-criterion">
        <span class="goal-criterion-label">
          <Icon name="check-list" size="sm" />
          {{ t('status.goalDoneWhen') }}
        </span>
        <p>{{ goal.completionCriterion }}</p>
      </div>
    </template>

    <template #foot>
      <div
        class="goal-footer"
        :inert="!expanded"
        :aria-hidden="!expanded"
      >
        <div class="goal-meta">
          <span>{{ goal.turnsUsed }} turns</span>
          <span>{{ formatTokens(goal.tokensUsed) }} tokens</span>
          <span>{{ formatMs(goal.wallClockMs) }}</span>
          <span v-if="goal.budget.tokenBudget !== null">{{ tokenPct }}% token budget</span>
        </div>
        <div class="goal-actions">
          <Button
            v-if="goal.status === 'active'"
            size="sm"
            variant="secondary"
            class="goal-action"
            @click.stop="emit('controlGoal', 'pause')"
          >
            <Icon name="pause" size="md" />
            <span>{{ t('status.goalPause') }}</span>
          </Button>
          <Button
            v-if="goal.status === 'paused' || goal.status === 'blocked'"
            size="sm"
            variant="ghost"
            class="goal-action goal-action--resume"
            @click.stop="emit('controlGoal', 'resume')"
          >
            <Icon name="play" size="md" />
            <span>{{ t('status.goalResume') }}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            class="goal-action goal-action--cancel"
            @click.stop="onCancel"
          >
            <Icon name="close" size="md" />
            <span>{{ t('status.goalCancel') }}</span>
          </Button>
        </div>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.goal-strip {
  --composer-send-size: 32px;
  --composer-send-inset: var(--space-2);
  --goal-corner-radius: calc((var(--composer-send-size) / 2) + var(--composer-send-inset) + var(--space-3));
  margin: var(--space-2) var(--space-4) 0;
  box-shadow: var(--shadow-input);
}
.goal-strip.ui-card {
  border-width: 0.5px;
  border-radius: var(--goal-corner-radius);
  corner-shape: superellipse(1.5);
}
.goal-strip:not(.expanded).ui-card {
  border-radius: var(--radius-full);
  corner-shape: round;
}
.goal-strip :deep(.ui-card__foot) {
  padding: var(--composer-send-inset);
}
.goal-strip :deep(.ui-card__head),
.goal-strip :deep(.ui-card__body),
.goal-strip :deep(.ui-card__foot) {
  padding-left: calc((var(--composer-send-inset) + var(--composer-send-size)) / 2);
}
.goal-strip :deep(.ui-card__body) {
  background: var(--color-surface-raised);
  max-height: 480px;
  overflow: hidden;
  opacity: 1;
  transition: max-height var(--duration-slow) var(--ease-out),
    padding-top var(--duration-slow) var(--ease-out),
    padding-bottom var(--duration-slow) var(--ease-out),
    opacity var(--duration-base) var(--ease-out);
}
/* Collapse the body and footer while keeping both mounted so their height and
   padding can animate instead of jumping between two layouts. */
.goal-strip:not(.expanded) :deep(.ui-card__body) {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  opacity: 0;
}
.goal-strip :deep(.ui-card__head) {
  border-bottom-color: var(--color-line);
  transition: border-bottom-color var(--duration-base) var(--ease-out);
}
.goal-strip:not(.expanded) :deep(.ui-card__head) {
  border-bottom-color: transparent;
}

.goal-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.goal-kicker {
  flex: none;
  color: var(--color-success);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  font-weight: var(--weight-semibold);
}
.goal-icon {
  flex: none;
  color: var(--color-success);
  margin-right: calc(-1 * var(--space-1));
}
.goal-objective {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-size: var(--text-base);
  text-align: left;
}
.goal-objective.expanded-hidden {
  visibility: hidden;
  pointer-events: none;
}
.goal-status {
  flex: none;
  color: var(--color-text-muted);
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
  font-weight: var(--weight-medium);
}
.goal-status--active { color: var(--color-success); }
.goal-status--paused { color: var(--color-warning); }
.goal-status--blocked { color: var(--color-danger); }
.goal-progress {
  width: 54px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  overflow: hidden;
  flex: none;
}
.goal-progress-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-success);
}
.goal-chevron {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  color: var(--color-text-muted);
  transition: transform var(--duration-fast) var(--ease-out);
  flex: none;
}
.goal-chevron.open {
  transform: rotate(90deg);
}
.goal-full {
  color: var(--color-text);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  max-height: 15em;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.goal-criterion {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 0.5px solid var(--color-line);
  color: var(--color-text-muted);
}
.goal-criterion-label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: 600;
  line-height: var(--leading-normal);
}
.goal-criterion p {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
}
.goal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
}
.goal-strip :deep(.ui-card__foot) {
  max-height: 100px;
  overflow: hidden;
  opacity: 1;
  transition: max-height var(--duration-slow) var(--ease-out),
    padding-top var(--duration-slow) var(--ease-out),
    padding-bottom var(--duration-slow) var(--ease-out),
    opacity var(--duration-base) var(--ease-out),
    border-top-color var(--duration-base) var(--ease-out);
}
.goal-strip:not(.expanded) :deep(.ui-card__foot) {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-top-color: transparent;
  opacity: 0;
}
.goal-meta {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
  font-weight: 450;
  font-variant-numeric: tabular-nums;
}
.goal-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
  flex: none;
}
.goal-action {
  flex: none;
  min-width: 0;
  height: var(--composer-send-size);
  border-radius: calc(var(--composer-send-size) / 2);
  padding-inline: var(--space-4);
}
.goal-action :deep(.ui-button__content) {
  gap: var(--space-1);
}
.goal-action--resume {
  color: var(--color-accent);
}
.goal-action--cancel {
  color: var(--color-danger);
}
@media (max-width: 640px) {
  .goal-strip {
    --composer-send-size: 36px;
    margin: var(--space-2) var(--space-3) 0;
  }
  .goal-progress {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .goal-strip :deep(.ui-card__head),
  .goal-strip :deep(.ui-card__body),
  .goal-strip :deep(.ui-card__foot) {
    transition: none;
  }
}
</style>
