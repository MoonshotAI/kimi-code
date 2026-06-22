<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppGoal } from '../api/types';

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
  <section class="goal-strip" :class="{ expanded }">
    <button class="goal-row" type="button" @click="expanded = !expanded">
      <span class="goal-kicker">Goal</span>
      <span class="goal-objective" :class="{ 'expanded-hidden': expanded }">{{ goal.objective }}</span>
      <span class="goal-status" :class="`status-${goal.status}`">{{ goal.status }}</span>
      <span class="goal-progress" aria-hidden="true">
        <span class="goal-progress-fill" :style="{ width: `${tokenPct}%` }"></span>
      </span>
      <svg
        class="goal-chevron"
        :class="{ open: expanded }"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 4l4 4-4 4" />
      </svg>
    </button>
    <div v-if="expanded" class="goal-body">
      <div class="goal-full">{{ goal.objective }}</div>
      <div v-if="goal.completionCriterion" class="goal-criterion">
        <span>Done when</span>
        <p>{{ goal.completionCriterion }}</p>
      </div>
      <div class="goal-stats">
        <span>{{ goal.turnsUsed }} turns</span>
        <span>{{ goal.tokensUsed.toLocaleString() }} tokens</span>
        <span>{{ formatMs(goal.wallClockMs) }}</span>
        <span v-if="goal.budget.tokenBudget !== null">{{ tokenPct }}% token budget</span>
      </div>
      <div class="goal-actions">
        <button
          v-if="goal.status !== 'paused'"
          type="button"
          class="goal-action"
          @click.stop="emit('controlGoal', 'pause')"
        >{{ t('status.goalPause') }}</button>
        <button
          v-if="goal.status === 'paused'"
          type="button"
          class="goal-action primary"
          @click.stop="emit('controlGoal', 'resume')"
        >{{ t('status.goalResume') }}</button>
        <button
          type="button"
          class="goal-action danger"
          @click.stop="emit('controlGoal', 'cancel')"
        >{{ t('status.goalCancel') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.goal-strip {
  margin: 8px 16px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.goal-row {
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.goal-kicker {
  flex: none;
  color: var(--ok);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 700;
  text-transform: uppercase;
}
.goal-objective {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: calc(var(--ui-font-size) - 1.5px);
}
.goal-objective.expanded-hidden {
  visibility: hidden;
  pointer-events: none;
}
.goal-status {
  flex: none;
  border-radius: 999px;
  padding: 1px 7px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--dim);
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}
.status-active { color: var(--ok); }
.status-blocked { color: var(--err); }
.status-paused { color: var(--warn); }
.goal-progress {
  width: 54px;
  height: 4px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
  flex: none;
}
.goal-progress-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ok);
}
.goal-chevron {
  width: 14px;
  height: 14px;
  color: var(--muted);
  transition: transform 0.12s;
  flex: none;
}
.goal-chevron.open {
  transform: rotate(90deg);
}
.goal-body {
  border-top: 1px solid var(--line);
  padding: 10px 12px 12px;
}
.goal-full {
  color: var(--ink);
  font-size: var(--ui-font-size-sm);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.goal-criterion {
  margin-top: 10px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  text-transform: uppercase;
}
.goal-criterion p {
  margin: 4px 0 0;
  color: var(--dim);
  font-family: var(--sans);
  font-size: var(--ui-font-size-xs);
  line-height: 1.45;
  text-transform: none;
}
.goal-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
}
.goal-stats span {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 7px;
  background: var(--bg);
}
.goal-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.goal-action {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  color: var(--ink);
  padding: 6px 10px;
  font-family: var(--sans);
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 500;
  cursor: pointer;
}
.goal-action:hover {
  background: var(--panel2);
  border-color: var(--bd);
}
.goal-action.primary {
  border-color: var(--blue);
  background: var(--blue);
  color: var(--bg);
}
.goal-action.primary:hover {
  background: color-mix(in srgb, var(--blue) 88%, var(--bg));
}
.goal-action.danger {
  border-color: color-mix(in srgb, var(--err) 30%, var(--line));
  color: var(--err);
}
.goal-action.danger:hover {
  background: color-mix(in srgb, var(--err) 8%, var(--panel));
  border-color: color-mix(in srgb, var(--err) 45%, var(--line));
}
@media (max-width: 640px) {
  .goal-strip {
    margin: 8px 10px 0;
  }
  .goal-progress {
    display: none;
  }
}
</style>
