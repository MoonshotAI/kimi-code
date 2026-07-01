<!-- apps/kimi-web/src/components/chat/ToolDiffPanel.vue -->
<!-- Right-side detail panel previewing an Edit/Write tool call's change. Opened
     by clicking the tool card; shows the synthesized line diff when it
     accurately represents the operation, otherwise the raw tool output. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ToolDiffTarget } from '../../types';
import DiffLines from './DiffLines.vue';
import PanelHeader from '../ui/PanelHeader.vue';

const props = defineProps<{ target: ToolDiffTarget }>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="tdp">
    <PanelHeader
      :title="target.title"
      :subtitle="target.path"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    />
    <div class="tdp-body">
      <DiffLines v-if="target.lines && target.lines.length > 0" :lines="target.lines" />
      <div v-else-if="target.output && target.output.length > 0" class="tdp-output">
        <div v-for="(line, i) in target.output" :key="i">{{ line }}</div>
      </div>
      <div v-else class="tdp-empty">{{ t('diff.noDiff') }}</div>
    </div>
  </div>
</template>

<style scoped>
.tdp {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg);
}
.tdp-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: var(--mono);
}
.tdp-output {
  padding: 8px 12px;
  color: var(--dim);
  font-size: var(--text-base);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.tdp-empty {
  padding: 32px 20px;
  color: var(--muted, #9098a0);
  font-size: var(--ui-font-size);
  text-align: center;
}
</style>
