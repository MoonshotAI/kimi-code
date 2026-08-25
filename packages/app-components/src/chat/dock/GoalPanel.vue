<!-- The goal's detail inside the dock's shared work panel (opened from the
     goal pill): the full objective + completion criterion, rendered with the
     app's full chat Markdown renderer. The pause / resume / cancel controls
     ride the panel's head (in ChatDock.vue). -->
<script setup lang="ts">
import type { AppGoal } from '@moonshot-ai/app-core/api';
import type { FilePreviewRequest } from '@moonshot-ai/app-core/client/types';
import { Icon } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import { useI18n } from 'vue-i18n';

defineProps<{
  goal: AppGoal;
  openFile?: (target: FilePreviewRequest) => void;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="goal-panel">
    <Markdown :text="goal.objective" :open-file="openFile" />
    <div v-if="goal.completionCriterion" class="goal-criterion">
      <span class="goal-criterion-label">
        <Icon name="check-list" size="sm" />
        {{ t('status.goalDoneWhen') }}
      </span>
      <Markdown :text="goal.completionCriterion" :open-file="openFile" />
    </div>
  </div>
</template>

<style scoped>
.goal-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}
.goal-criterion {
  padding-top: var(--space-2);
  border-top: 0.5px solid var(--color-line);
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
  margin-bottom: var(--space-1);
}
</style>
