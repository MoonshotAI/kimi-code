<!-- apps/kimi-web/src/components/TodoCard.vue -->
<!-- Todo list driven by the model's TodoList tool (latest full-list write
     wins). Two render modes: a bordered card (used inside the wide-screen
     floating stack — the PARENT positions it) and `inline` for the ~/todo tab.
     Collapsible to a slim header so it doesn't cover the transcript. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TodoView } from '../types';

const props = defineProps<{
  todos: TodoView[];
  /** Render as a normal block (tab content) instead of a bordered card. */
  inline?: boolean;
}>();

const { t } = useI18n();

// Collapse only applies to the floating CARD (it overlays the transcript). In
// the dedicated ~/todo TAB the whole pane IS the list, so collapsing it would
// just hide everything the user opened the tab to see — keep it always open.
const collapsed = ref(false);
const canCollapse = computed(() => !props.inline);
const showList = computed(() => props.inline || !collapsed.value);

function toggle(): void {
  if (canCollapse.value) collapsed.value = !collapsed.value;
}

const doneCount = computed(() => props.todos.filter((td) => td.status === 'done').length);

function glyph(status: TodoView['status']): string {
  return status === 'done' ? 'done' : status === 'in_progress' ? 'in_progress' : 'pending';
}
</script>

<template>
  <div class="todo-card" :class="{ 'tab-mode': inline }">
    <component :is="canCollapse ? 'button' : 'div'" class="tc-head" :class="{ static: !canCollapse }" :type="canCollapse ? 'button' : undefined" @click="toggle">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <polyline points="2,4.5 3.5,6 5.5,3" />
        <polyline points="2,11 3.5,12.5 5.5,9.5" />
        <line x1="8" y1="4.5" x2="14" y2="4.5" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </svg>
      <span class="tc-title">{{ t('tasks.todoTag') }}</span>
      <span v-if="todos.length > 0" class="tc-count">{{ doneCount }}/{{ todos.length }}</span>
      <svg v-if="canCollapse && todos.length > 0" class="tc-chev" :class="{ open: !collapsed }" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="4,6 8,10 12,6" />
      </svg>
    </component>

    <div v-if="showList" class="tc-list">
      <div v-if="todos.length === 0" class="tc-empty">{{ t('tasks.emptyTodo') }}</div>
      <div v-for="(td, i) in todos" :key="i" class="tc-row" :class="`s-${td.status}`">
        <span class="tc-glyph" :class="`g-${glyph(td.status)}`" />
        <span class="tc-name">{{ td.title }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  font-size: var(--ui-font-size-sm);
  overflow: hidden;
}

/* Tab mode: plain block instead of a bordered card */
.todo-card.tab-mode {
  width: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
}
.todo-card.tab-mode .tc-head {
  display: none;
}
.todo-card.tab-mode .tc-list {
  padding: 6px 12px 10px;
  max-height: none;
  border-top: none;
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
  font-size: var(--ui-font-size-xs);
  line-height: 1.4;
}
.tc-head:hover { color: var(--ink); }
/* Tab-mode header is a static label, not a collapse toggle. */
.tc-head.static { cursor: default; }
.tc-head.static:hover { color: var(--muted); }
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
  padding: 4px 10px 6px 10px;
  max-height: 40vh;
  overflow-y: auto;
}
.tc-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 20px;
  padding: 2px 0;
  line-height: 20px;
}
.tc-glyph {
  flex: none;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--line);
  border-radius: 50%;
  position: relative;
  background: var(--bg);
  box-sizing: border-box;
}
.tc-glyph.g-done {
  background: color-mix(in srgb, var(--blue) 75%, var(--panel));
  border-color: color-mix(in srgb, var(--blue) 75%, var(--panel));
}
.tc-glyph.g-done::after {
  content: '';
  position: absolute;
  left: 4.5px;
  top: 2.5px;
  width: 4.5px;
  height: 7.5px;
  border: solid var(--bg);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(42deg);
}
.tc-glyph.g-in_progress {
  border-color: var(--blue);
}
.tc-glyph.g-in_progress::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 5px;
  height: 5px;
  background: var(--blue);
  border-radius: 50%;
  transform: translate(-50%, -50%);
}
.tc-name { min-width: 0; overflow-wrap: anywhere; color: var(--ink); }

.tc-empty {
  padding: 18px 0;
  text-align: center;
  color: var(--faint);
  font-size: var(--ui-font-size-sm);
}
.tc-row.s-pending .tc-name { color: var(--muted); }
.tc-row.s-in_progress .tc-name { font-weight: 600; }
.tc-row.s-done .tc-name { color: var(--faint); text-decoration: line-through; }

/* Mobile (~/todo tab): match the chat font bump and give the collapsible
   header a ≥44px tap target; row spacing opens up for finger-reading. */
@media (max-width: 640px) {
  .todo-card.tab-mode .tc-head {
    min-height: 44px;
    font-size: var(--ui-font-size);
  }
  .todo-card.tab-mode .tc-list {
    font-size: var(--ui-font-size-lg);
  }
  .todo-card.tab-mode .tc-row {
    padding: 5px 0;
  }
}
</style>
