<!-- apps/kimi-web/src/components/chat/GoalPanel.vue -->
<!-- The goal's detail inside the dock's shared work panel (opened from the
     goal pill): the full objective + completion criterion. The pause /
     resume / cancel controls ride the panel's head and the meta counts its
     footer (both in ChatDock.vue). -->
<script setup lang="ts">
import type { AppGoal } from '../../api/types';
import { Icon } from '@moonshot-ai/app-ui';
import { useI18n } from 'vue-i18n';

defineProps<{ goal: AppGoal }>();

const { t } = useI18n();
</script>

<template>
  <div class="goal-panel">
    <div class="goal-full">{{ goal.objective }}</div>
    <div v-if="goal.completionCriterion" class="goal-criterion">
      <span class="goal-criterion-label">
        <Icon name="check-list" size="sm" />
        {{ t('status.goalDoneWhen') }}
      </span>
      <p>{{ goal.completionCriterion }}</p>
    </div>
  </div>
</template>

<style scoped>
.goal-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.goal-full {
  color: var(--color-text);
  font-size: var(--text-base);
  line-height: var(--leading-prose);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.goal-criterion {
  padding-top: var(--space-2);
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
  font-weight: var(--weight-section-label);
  line-height: var(--leading-normal);
}
.goal-criterion p {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font: var(--text-base)/var(--leading-prose) var(--font-ui);
}
</style>
