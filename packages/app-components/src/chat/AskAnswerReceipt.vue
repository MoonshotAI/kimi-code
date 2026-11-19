<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import ToolDisclosure from './tool-calls/ToolDisclosure.vue';
import ToolPanel from './tool-calls/ToolPanel.vue';

defineProps<{
  rows: readonly { question: string; answer: string }[];
  open: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
</script>

<template>
  <ToolDisclosure status="ok" :open="open" expandable @toggle="emit('toggle')">
    <template #leading><Icon name="help-circle" size="sm" /></template>
    <span class="tl-name">{{ t('tools.ask.collected') }}</span>
    <template #body>
      <ToolPanel scroll>
        <div class="rc-list">
          <div v-for="(row, qi) in rows" :key="qi" class="rc-q">
            <div class="rc-qtext">{{ row.question }}</div>
            <div class="rc-answer">{{ row.answer }}</div>
          </div>
        </div>
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.rc-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rc-qtext {
  color: var(--color-text);
  font: var(--text-base)/20px var(--font-ui);
}
.rc-answer {
  margin-top: var(--space-2);
  color: var(--color-text-muted);
  font: var(--text-base)/20px var(--font-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
