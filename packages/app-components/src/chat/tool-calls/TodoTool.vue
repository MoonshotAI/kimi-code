<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { parseArgRecord, str } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import StatusGlyph, { type StatusGlyphStatus } from '../StatusGlyph.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

interface TodoItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

function parseTodos(arg: string): TodoItem[] {
  const d = parseArgRecord(arg);
  const items = d && Array.isArray(d.todos) ? d.todos : d && Array.isArray(d.items) ? d.items : undefined;
  if (!items) return [];
  const out: TodoItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const title = str(rec.title) ?? str(rec.content) ?? str(rec.activeForm) ?? str(rec.text);
    if (!title) continue;
    const s = str(rec.status) ?? 'pending';
    out.push({
      title,
      status: s === 'in_progress' ? 'in_progress' : s === 'done' || s === 'completed' ? 'done' : 'pending',
    });
  }
  return out;
}

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const todos = computed(() => parseTodos(props.tool.arg));
const doneCount = computed(() => todos.value.filter((td) => td.status === 'done').length);
const total = computed(() => todos.value.length);
const current = computed(() => todos.value.find((td) => td.status === 'in_progress'));

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);

const canExpand = computed(() => total.value > 0 || hasOutput.value);
const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [props.tool.defaultExpanded, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);

function glyphStatus(item: TodoItem): StatusGlyphStatus {
  return item.status === 'in_progress' ? 'run' : item.status;
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="check-list" size="sm" /></template>
    <span class="tl-name">{{ t('tools.label.todo') }}</span>
    <span v-if="current && !open" class="tl-dim">{{ current.title }}</span>
    <span v-if="total > 0 && !open" class="tl-faint">{{ doneCount }} / {{ total }}</span>
    <template #body>
      <ToolPanel v-if="total > 0" scroll>
        <template #head>
          <span class="todo-head">
            <span class="todo-current">{{ current?.title ?? '' }}</span>
            <span class="todo-count">{{ doneCount }} / {{ total }}</span>
          </span>
        </template>
        <div class="todo-list">
          <div v-for="(td, i) in todos" :key="i" class="todo-row" :class="`s-${td.status}`">
            <StatusGlyph :status="glyphStatus(td)" />
            <span class="todo-title">{{ td.title }}</span>
          </div>
        </div>
      </ToolPanel>
      <ToolPanel v-else-if="hasOutput">
        <OutputPanel :lines="tool.output" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.todo-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.todo-current {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.todo-count {
  flex: none;
  color: var(--color-text-faint);
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.todo-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-base);
  line-height: 20px;
  color: var(--color-text);
}
.todo-title {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.todo-row.s-in_progress .todo-title {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.todo-row.s-done .todo-title {
  color: var(--color-text-quaternary);
}
</style>
