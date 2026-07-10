<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppGoal } from '../../api/types';
import Card from '../ui/Card.vue';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';

const props = defineProps<{ goal: AppGoal; forceExpanded?: number }>();
const emit = defineEmits<{ controlGoal: [action: 'pause' | 'resume' | 'cancel'] }>();

const { t } = useI18n();

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
</script>

<template>
  <Card class="goal-strip" :class="{ expanded }">
    <template #head>
      <button class="goal-row" type="button" @click="expanded = !expanded">
        <span class="goal-kicker">{{ t('status.goalLabel') }}</span>
        <span class="goal-objective" :class="{ 'expanded-hidden': expanded }">{{ goal.objective }}</span>
        <Badge
          :variant="goal.status === 'active' ? 'success' : goal.status === 'blocked' ? 'danger' : goal.status === 'paused' ? 'warning' : 'neutral'"
          size="sm"
          class="goal-status"
        >{{ goalStatusLabel(goal.status) }}</Badge>
        <span class="goal-progress" aria-hidden="true">
          <span class="goal-progress-fill" :style="{ width: `${tokenPct}%` }"></span>
        </span>
        <Icon class="goal-chevron" :class="{ open: expanded }" name="chevron-right" size="md" />
      </button>
    </template>

    <template v-if="expanded" #default>
      <div class="goal-full">{{ goal.objective }}</div>
      <div v-if="goal.completionCriterion" class="goal-criterion">
        <span>Done when</span>
        <p>{{ goal.completionCriterion }}</p>
      </div>
    </template>

    <template v-if="expanded" #foot>
      <div class="goal-footer">
        <div class="goal-meta">
          <span>{{ goal.turnsUsed }} turns</span>
          <span>{{ goal.tokensUsed.toLocaleString() }} tokens</span>
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
            variant="primary"
            class="goal-action"
            @click.stop="emit('controlGoal', 'resume')"
          >
            <Icon name="play" size="md" />
            <span>{{ t('status.goalResume') }}</span>
          </Button>
          <Button
            size="sm"
            variant="danger-soft"
            class="goal-action"
            @click.stop="emit('controlGoal', 'cancel')"
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
  margin: var(--space-2) var(--space-4) 0;
}
.goal-strip.ui-card {
  border-radius: calc((var(--composer-send-size) / 2) + var(--composer-send-inset));
}
.goal-strip :deep(.ui-card__foot) {
  padding: var(--composer-send-inset);
}
.goal-strip :deep(.ui-card__head),
.goal-strip :deep(.ui-card__body),
.goal-strip :deep(.ui-card__foot) {
  padding-left: calc((var(--composer-send-inset) + var(--composer-send-size)) / 2);
}
/* When collapsed the body/foot slots are not rendered; collapse the (always-
   rendered) Card body and drop the head border so the strip is a single row. */
.goal-strip:not(.expanded) :deep(.ui-card__body) { display: none; }
.goal-strip:not(.expanded) :deep(.ui-card__head) { border-bottom: none; }

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
}
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
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.goal-criterion {
  margin-top: var(--space-3);
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
  text-transform: uppercase;
}
.goal-criterion p {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
  text-transform: none;
}
.goal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
}
.goal-meta {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font: 12px/var(--leading-normal) var(--font-ui);
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
@media (max-width: 640px) {
  .goal-strip {
    --composer-send-size: 36px;
    margin: var(--space-2) var(--space-3) 0;
  }
  .goal-progress {
    display: none;
  }
}
</style>
