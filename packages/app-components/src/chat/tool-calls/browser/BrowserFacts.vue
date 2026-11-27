<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { BrowserFact } from '../browserToolView';
import BrowserValueView from './BrowserValueView.vue';

withDefaults(defineProps<{ facts: BrowserFact[]; layout?: 'rows' | 'chips' }>(), { layout: 'rows' });
const { t } = useI18n();
</script>

<template>
  <div v-if="layout === 'chips'" class="bf-chips">
    <span v-for="item in facts" :key="item.key" class="bf-chip">
      <span class="bf-chip-label">{{ t(`tools.browser.detail.facts.${item.key}`) }}</span>
      <span class="bf-chip-value"><BrowserValueView :value="item.value" /></span>
    </span>
  </div>
  <dl v-else class="bf-rows">
    <template v-for="item in facts" :key="item.key">
      <dt>{{ t(`tools.browser.detail.facts.${item.key}`) }}</dt>
      <dd><BrowserValueView :value="item.value" /></dd>
    </template>
  </dl>
</template>

<style scoped>
.bf-rows {
  display: grid;
  grid-template-columns: fit-content(40%) minmax(0, 1fr);
  gap: var(--space-1) var(--space-4);
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.bf-rows dt {
  color: var(--color-text-muted);
  user-select: none;
}
.bf-rows dd {
  min-width: 0;
  margin: 0;
}
.bf-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bf-chip {
  display: inline-flex;
  max-width: 100%;
  border: var(--p-hairline) solid var(--color-subtle);
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow: hidden;
}
.bf-chip-label,
.bf-chip-value {
  padding-inline: var(--space-1);
}
.bf-chip-label {
  flex: none;
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
  border-right: var(--p-hairline) solid var(--color-subtle);
  user-select: none;
}
.bf-chip-value {
  min-width: 0;
}
</style>
