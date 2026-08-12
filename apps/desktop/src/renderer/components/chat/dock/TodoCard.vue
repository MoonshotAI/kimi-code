<!-- apps/web/src/components/chat/dock/TodoCard.vue -->
<!-- Read-only todo list driven by the model's TodoList tool (latest full-list
     write wins). Rendered inside the dock panel, which owns the card shell
     and the progress header — this is just the rows + empty state. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { TodoView } from '../../../types';
import { Icon, Spinner } from '@moonshot-ai/app-ui';

const props = defineProps<{
  todos: TodoView[];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="todo-card">
    <div v-if="props.todos.length === 0" class="tc-empty">
      <Icon name="check-list" size="lg" class="tc-empty-ico" />
      <span>{{ t('tasks.emptyTodo') }}</span>
    </div>

    <div v-for="(td, i) in props.todos" :key="i" class="tc-row" :class="`s-${td.status}`">
      <span class="tc-glyph" :class="`g-${td.status}`" aria-hidden="true">
        <Spinner v-if="td.status === 'in_progress'" size="xs" class="tc-spin" />
        <Icon v-else-if="td.status === 'done'" name="circle-check" size="md" />
      </span>
      <span class="tc-name">{{ td.title }}</span>
    </div>
  </div>
</template>

<style scoped>
.todo-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: var(--text-base);
}

.tc-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text);
}
.tc-name { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: var(--leading-caption); }
.tc-row.s-in_progress .tc-name { font-weight: var(--weight-medium); }
.tc-row.s-pending .tc-name { color: var(--color-text-muted); }

.tc-glyph {
  flex: none;
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
}
.tc-glyph.g-done { color: var(--color-success); }
.tc-glyph.g-pending { border: var(--p-ring-stroke) solid var(--color-line-strong); }
/* The xs Spinner's ring lands on the same --p-ic-md circle the check icon
   and the pending ring draw, at the shared 1.5px stroke — the primitive owns
   that geometry now. The arc keeps the row's ink colour instead of the
   default accent. */
.tc-glyph .tc-spin {
  color: var(--color-text);
}

.tc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}
.tc-empty-ico { width: var(--p-empty-ico); height: var(--p-empty-ico); color: var(--color-line-strong); }

/* Mobile (~/todo tab): match the chat font bump; row spacing opens up. */
@media (max-width: 640px) {
  .todo-card { font-size: var(--text-lg); }
  .tc-row { padding: var(--space-2) var(--space-3); }
}
</style>
