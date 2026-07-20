<!-- Shared line-oriented tool output block. Keeps long outputs to a readable
     viewport while preserving the tool card's normal typography. -->
<script setup lang="ts">
import { computed } from 'vue';

const OUTPUT_SCROLL_LINE_COUNT = 50;

const props = defineProps<{
  lines?: string[];
  emptyText?: string;
}>();

const outputLines = computed(() => props.lines ?? []);
const isScrollable = computed(() => outputLines.value.length > OUTPUT_SCROLL_LINE_COUNT);
const outputStyle = { '--tool-output-visible-lines': String(OUTPUT_SCROLL_LINE_COUNT) };
</script>

<template>
  <div class="bb-code tool-output-block" :class="{ scroll: isScrollable }" :style="outputStyle">
    <div v-if="outputLines.length === 0 && emptyText" class="bb-empty">{{ emptyText }}</div>
    <div v-for="(line, i) in outputLines" :key="i">{{ line }}</div>
  </div>
</template>

<style scoped>
.tool-output-block {
  margin-top: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.tool-output-block.scroll {
  max-height: calc(var(--tool-output-visible-lines) * 1lh);
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.bb-empty {
  color: var(--color-text-muted);
  font-style: italic;
}
</style>
