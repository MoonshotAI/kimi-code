<!-- Todo-list tool: the row shows the currently active task with a done/total
     count and a mini progress bar; expanding lists every item with the same
     status glyphs as the dock todo panel. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '../../../types';
import { parseArgRecord, str } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
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
const progress = computed(() => (total.value > 0 ? doneCount.value / total.value : 0));

// Read-only queries (TodoList / TodoRead) carry no `todos` array in the
// input, but the result can still hold the current list or status text —
// keep that output reachable when there are no parsed items to list.
const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);

const canExpand = computed(() => total.value > 0 || hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

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
    <span v-if="current" class="tl-dim">{{ current.title }}</span>
    <template #trailing>
      <span v-if="total > 0" class="tl-chip">{{ doneCount }}/{{ total }}</span>
      <span v-if="total > 0" class="todo-bar" aria-hidden="true">
        <span class="todo-fill" :style="{ width: `${progress * 100}%` }" />
      </span>
    </template>
    <template #body>
      <div v-if="total > 0" class="todo-list">
        <div v-for="(td, i) in todos" :key="i" class="todo-row" :class="`s-${td.status}`">
          <StatusGlyph :status="glyphStatus(td)" />
          <span class="todo-title">{{ td.title }}</span>
        </div>
      </div>
      <OutputPanel v-else-if="hasOutput" :lines="tool.output" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
/* Mini progress bar — mirrors the done/total chip. */
.todo-bar {
  display: inline-flex;
  width: 36px;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  overflow: hidden;
  flex: none;
}
.todo-fill {
  background: var(--color-success);
  border-radius: var(--radius-full);
  transition: width var(--duration-slow) var(--ease-out);
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  padding: var(--space-2) var(--space-3);
  max-height: calc(12 * 1.6 * var(--content-font-size));
  overflow-y: auto;
  overscroll-behavior: contain;
}
.todo-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 0;
  font-size: calc(var(--content-font-size) - 1px);
  color: var(--color-text);
}
.todo-title {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.todo-row.s-in_progress .todo-title {
  font-weight: var(--weight-medium);
}
.todo-row.s-done .todo-title {
  color: var(--color-text-faint);
  text-decoration: line-through;
}
</style>
