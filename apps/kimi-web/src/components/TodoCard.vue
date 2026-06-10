<!-- apps/kimi-web/src/components/TodoCard.vue -->
<!-- Floating todo card pinned to the top-right of the conversation pane.
     Driven by the model's TodoList tool (latest full-list write wins); stays
     visible across turns until the list is cleared. Collapsible to a slim
     header so it doesn't cover the transcript while reading. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TodoView } from '../types';

const props = defineProps<{
  todos: TodoView[];
  /** Mobile shell: clear the taller mobile TabBar. */
  mobile?: boolean;
  /** Render as a normal block (tab content) instead of a floating card. */
  inline?: boolean;
}>();

const { t } = useI18n();

const collapsed = ref(false);

const doneCount = computed(() => props.todos.filter((td) => td.status === 'done').length);

function glyph(status: TodoView['status']): string {
  return status === 'done' ? '✓' : status === 'in_progress' ? '●' : '○';
}
</script>

<template>
  <div class="todo-card" :class="{ mobile, 'tab-mode': inline }">
    <button class="tc-head" type="button" @click="collapsed = !collapsed">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <polyline points="2,4.5 3.5,6 5.5,3" />
        <polyline points="2,11 3.5,12.5 5.5,9.5" />
        <line x1="8" y1="4.5" x2="14" y2="4.5" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </svg>
      <span class="tc-title">{{ t('tasks.todoTag') }}</span>
      <span v-if="todos.length > 0" class="tc-count">{{ doneCount }}/{{ todos.length }}</span>
      <svg v-if="todos.length > 0" class="tc-chev" :class="{ open: !collapsed }" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="4,6 8,10 12,6" />
      </svg>
    </button>

    <div v-if="!collapsed" class="tc-list">
      <div v-if="todos.length === 0" class="tc-empty">{{ t('tasks.emptyTodo') }}</div>
      <div v-for="(td, i) in todos" :key="i" class="tc-row" :class="`s-${td.status}`">
        <span class="tc-glyph">{{ glyph(td.status) }}</span>
        <span class="tc-name">{{ td.title }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-card {
  position: absolute;
  /* Below the 32px desktop TabBar */
  top: 42px;
  right: 16px;
  z-index: 5;
  width: 260px;
  max-width: calc(100% - 32px);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  font-size: 13px;
  overflow: hidden;
}
/* Below the 46px mobile TabBar */
.todo-card.mobile { top: 56px; right: 10px; width: 220px; }

/* Tab mode: static block instead of floating card */
.todo-card.tab-mode {
  position: static;
  width: 100%;
  max-width: none;
  border: none;
  border-radius: 0;
  background: transparent;
  z-index: auto;
}
.todo-card.tab-mode .tc-head {
  padding: 8px 14px;
  font-size: 13px;
}
.todo-card.tab-mode .tc-list {
  padding: 6px 14px 10px;
  max-height: none;
}

.tc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.4;
}
.tc-head:hover { color: var(--ink); }
.tc-title { font-weight: 700; letter-spacing: 0.04em; }
.tc-count { color: var(--faint); }
.tc-chev {
  margin-left: auto;
  transition: transform 0.15s;
  transform: rotate(-90deg);
}
.tc-chev.open { transform: none; }

.tc-list {
  border-top: 1px solid var(--line);
  padding: 4px 10px 6px;
  max-height: 40vh;
  overflow-y: auto;
}
.tc-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 2px 0;
  line-height: 1.5;
}
.tc-glyph { flex: none; font-family: var(--mono); }
.tc-name { min-width: 0; overflow-wrap: anywhere; color: var(--ink); }

.tc-empty {
  padding: 18px 0;
  text-align: center;
  color: var(--faint);
  font-size: 13px;
}
.tc-row.s-pending .tc-glyph { color: var(--faint); }
.tc-row.s-pending .tc-name { color: var(--muted); }
.tc-row.s-in_progress .tc-glyph { color: var(--blue); }
.tc-row.s-in_progress .tc-name { font-weight: 600; }
.tc-row.s-done .tc-glyph { color: var(--ok); }
.tc-row.s-done .tc-name { color: var(--faint); text-decoration: line-through; }
</style>
