<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { Icon, Spinner } from '@moonshot-ai/app-ui';
import type { WorktreeDeleteListItem } from '@moonshot-ai/app-client/lib';
import { MANAGE_DELETE_LIST_NATURAL_ROWS } from './manageDeleteList';

const props = defineProps<{
  items: readonly WorktreeDeleteListItem[];
}>();

const listRef = ref<HTMLElement | null>(null);
const atEnd = ref(false);
const capped = computed(() => props.items.length > MANAGE_DELETE_LIST_NATURAL_ROWS);

function syncEnd(): void {
  const el = listRef.value;
  if (el === null) return;
  atEnd.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
}

onMounted(syncEnd);
watch(
  () => props.items.length,
  () => void nextTick(syncEnd),
);
</script>

<template>
  <ul
    ref="listRef"
    class="manage-delete-list"
    :class="{ 'is-capped': capped, 'is-faded': capped && !atEnd }"
    @scroll.passive="syncEnd"
  >
    <li
      v-for="item in items"
      :key="item.key"
      class="manage-delete-list__item"
      :class="item.state ? `is-${item.state}` : undefined"
    >
      <span class="manage-delete-list__name" :class="{ 'is-directory': item.nameIsDirectory }">{{ item.name }}</span>
      <span class="manage-delete-list__meta">{{ item.meta }}</span>
      <span v-if="item.loss" class="manage-delete-list__loss">{{ item.loss }}</span>
      <span v-if="item.state" class="manage-delete-list__state">
        <Spinner v-if="item.state === 'deleting'" size="xs" />
        <Icon v-else-if="item.state === 'deleted'" name="check" size="sm" />
        <Icon v-else-if="item.state === 'failed'" name="alert-triangle" size="sm" />
        <span>{{ item.stateText }}</span>
      </span>
    </li>
  </ul>
</template>

<style scoped>
.manage-delete-list {
  --manage-delete-row: 28px;
  margin: 0 0 0 calc(var(--p-ic-md) + var(--space-2));
  padding: var(--space-1) 0;
  list-style: none;
  border-radius: var(--radius-lg);
  background: var(--color-surface-sunken);
}
.manage-delete-list.is-capped {
  max-height: calc(var(--space-1) + var(--manage-delete-row) * 3.5);
  padding-bottom: 0;
  overflow-y: auto;
  scrollbar-width: none;
}
.manage-delete-list.is-capped::-webkit-scrollbar { display: none; }
.manage-delete-list.is-faded {
  -webkit-mask-image: linear-gradient(to bottom, var(--color-text-strong) calc(100% - var(--space-4)), transparent);
  mask-image: linear-gradient(to bottom, var(--color-text-strong) calc(100% - var(--space-4)), transparent);
}
.manage-delete-list__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--manage-delete-row);
  padding: 0 var(--space-3);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  white-space: nowrap;
}
.manage-delete-list__name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
  color: var(--color-text);
}
.manage-delete-list__name.is-directory { font-family: var(--font-ui); }
.manage-delete-list__meta {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-faint);
}
.manage-delete-list__loss {
  flex: none;
  color: var(--color-warning);
}
.manage-delete-list__state {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: var(--space-1);
  color: var(--color-text-faint);
}
.manage-delete-list__item.is-waiting { opacity: 0.6; }
.manage-delete-list__item.is-deleted .manage-delete-list__state { color: var(--color-success); }
.manage-delete-list__item.is-failed .manage-delete-list__state { color: var(--color-danger); }
</style>
