<!-- Shared monospace output panel for expanded tool rows: sunken surface,
     hairline edge (needed in dark, where sunken == page bg), 12-line scroll
     cap. Used for terminal output, fetched content, and any raw line dump. -->
<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    lines?: string[];
    emptyText?: string;
  }>(),
  { lines: undefined, emptyText: '' },
);

const outputLines = computed(() => props.lines ?? []);
</script>

<template>
  <div class="op">
    <div v-if="outputLines.length === 0 && emptyText" class="op-empty">{{ emptyText }}</div>
    <div v-for="(line, i) in outputLines" :key="i">{{ line }}</div>
  </div>
</template>

<style scoped>
.op {
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.6;
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
  color: var(--color-text);
  background: var(--color-well);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: calc(12 * 1lh);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.op-empty {
  color: var(--color-text-faint);
  font-style: italic;
}
</style>
