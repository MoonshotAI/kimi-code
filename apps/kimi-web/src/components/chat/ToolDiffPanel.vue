<!-- apps/kimi-web/src/components/chat/ToolDiffPanel.vue -->
<!-- Right-side detail panel previewing an Edit/Write tool call's change. Opened
     by clicking the tool card; shows the synthesized line diff when it
     accurately represents the operation, otherwise the raw tool output. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ToolDiffTarget } from '../../types';
import DiffLines from './DiffLines.vue';

const props = defineProps<{ target: ToolDiffTarget }>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="tdp">
    <div class="tdp-header">
      <span class="tdp-title">{{ target.title }}</span>
      <span v-if="target.path" class="tdp-sub" :title="target.path">{{ target.path }}</span>
      <button
        type="button"
        class="tdp-close"
        :title="t('thinking.close')"
        :aria-label="t('thinking.close')"
        @click="emit('close')"
      >
        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
      </button>
    </div>
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
.tdp-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--panel-head-h, 32px);
  padding: 0 6px 0 12px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.tdp-title {
  flex: none;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--ink);
}
.tdp-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
}
.tdp-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
}
.tdp-close:hover {
  background: var(--hover);
  color: var(--ink);
}
.tdp-close:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
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
  font-size: calc(var(--ui-font-size) - 2.5px);
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
