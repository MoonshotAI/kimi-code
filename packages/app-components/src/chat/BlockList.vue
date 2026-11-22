<script setup lang="ts" generic="T">
import { computed, inject } from 'vue';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import HistoryRow from './HistoryRow.vue';

const props = withDefaults(defineProps<{
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  enabled?: boolean;
  scope?: string;
  gap?: (item: T, index: number) => number;
}>(), { enabled: false, scope: 'items' });

const parentState = inject(HistoryStateKey, undefined);
const stateKey = `blocks:${props.scope}`;
const records = (parentState?.get(stateKey) as Map<string, Map<string, unknown>> | undefined) ?? new Map<string, Map<string, unknown>>();
parentState?.set(stateKey, records);
const keys = computed(() => props.items.map(props.itemKey));

function rowState(key: string): Map<string, unknown> {
  let state = records.get(key);
  if (!state) {
    state = new Map();
    records.set(key, state);
  }
  return state;
}
</script>

<template>
  <template v-if="!enabled"><slot v-for="(item, index) in items" :key="itemKey(item, index)" :item="item" :index="index" /></template>
  <div v-else class="block-list" role="list">
    <HistoryRow
      v-for="(item, index) in items"
      :key="keys[index]"
      :state="rowState(keys[index]!)"
      :data-history-key="keys[index]"
      role="listitem"
      :aria-posinset="index + 1"
      :aria-setsize="items.length"
      :style="gap ? `padding-top: ${gap(item, index)}px` : undefined"
    >
      <slot :item="item" :index="index" />
    </HistoryRow>
  </div>
</template>

<style scoped>
.block-list { min-width: 0; flex-shrink: 0; overflow-anchor: none; }
</style>
