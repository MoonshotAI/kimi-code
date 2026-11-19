<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BrowserValue } from '../browserToolView';
import BrowserValueView from './BrowserValueView.vue';

export type BrowserTableCell = BrowserValue | { type: 'states'; items: string[] } | null;

const props = defineProps<{ columns: string[]; rows: BrowserTableCell[][] }>();
const { t, te } = useI18n();

function blank(cell: BrowserTableCell | undefined): boolean {
  if (cell === null || cell === undefined) return true;
  if (cell.type === 'states') return cell.items.length === 0;
  return (cell.type === 'text' || cell.type === 'code') && cell.text === '';
}

const shown = computed(() => props.columns
  .map((name, index) => ({ name, index }))
  .filter(({ index }) => props.rows.length === 0 || props.rows.some((row) => !blank(row[index]))));

function stateLabel(state: string): string {
  const key = `tools.browser.detail.states.${state}`;
  return te(key) ? t(key) : state;
}
</script>

<template>
  <table class="bt">
    <thead>
      <tr>
        <th v-for="column in shown" :key="column.name" scope="col">{{ t(`tools.browser.detail.columns.${column.name}`) }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, rowIndex) in rows" :key="rowIndex">
        <td v-for="column in shown" :key="column.name" :class="`is-${row[column.index]?.type ?? 'empty'}`">
          <template v-if="row[column.index]?.type === 'states'">
            <span v-for="state in (row[column.index] as { items: string[] }).items" :key="state" class="bt-state">{{ stateLabel(state) }}</span>
          </template>
          <BrowserValueView v-else :value="(row[column.index] ?? null) as BrowserValue | null" />
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.bt {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.bt th {
  padding: 0 var(--space-3) var(--space-1) 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  text-align: left;
  white-space: nowrap;
  user-select: none;
}
.bt td {
  padding: 2px var(--space-3) 2px 0;
  vertical-align: top;
  border-top: var(--p-hairline) solid var(--color-subtle);
  user-select: text;
}
.bt td.is-text,
.bt td.is-url {
  min-width: 9em;
}
.bt td :deep(.bv-text),
.bt td :deep(.bv-code) {
  overflow-wrap: break-word;
}
.bt th:last-child,
.bt td:last-child {
  padding-right: 0;
}
.bt-state {
  display: inline-block;
  margin-right: var(--space-1);
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--color-fill-2);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}
</style>
