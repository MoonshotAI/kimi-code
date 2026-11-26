<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import { GOAL_TOOL_KIND, useGoalToolCard, type ToolCardProps } from './goalToolOutput';

const props = withDefaults(defineProps<ToolCardProps>(), { mobile: false });
const { t } = useI18n();
const { status, kind, hasOutput, toolNameLabel, objective, criterion, headline, visibleOutput, canExpand, open } = useGoalToolCard(props, t);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="target" size="sm" /></template>
    <span class="tl-name">{{ toolNameLabel }}</span>
    <span v-if="headline" class="tl-dim">{{ headline }}</span>
    <span v-if="kind === GOAL_TOOL_KIND.create" class="tl-faint">{{ t('status.goalStatusActive') }}</span>
    <template #body>
      <ToolPanel scroll>
        <div v-if="objective" class="goal-block">
          <div class="goal-text">{{ objective }}</div>
          <div v-if="criterion" class="goal-criterion">{{ criterion }}</div>
        </div>
        <OutputPanel v-if="hasOutput" :lines="visibleOutput" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.goal-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.goal-text {
  color: var(--color-text);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}
.goal-criterion {
  color: var(--color-text-muted);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
