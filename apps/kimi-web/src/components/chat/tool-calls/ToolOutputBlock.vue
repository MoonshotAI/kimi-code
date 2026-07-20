<!-- Shared line-oriented tool output block. Keeps long outputs to a readable
     viewport while preserving the tool card's normal typography.
     kimi-ui: outputs beyond TRUNCATE_LINE_COUNT render tail-biased (the last
     N lines, where errors/results live) behind an expand button, so huge logs
     no longer put thousands of divs in the DOM. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const OUTPUT_SCROLL_LINE_COUNT = 50;
// Default render window for long outputs (tail-biased).
const TRUNCATE_LINE_COUNT = 80;

const props = defineProps<{
  lines?: string[];
  emptyText?: string;
}>();

const { t } = useI18n();
const expanded = ref(false);

const outputLines = computed(() => props.lines ?? []);
const truncated = computed(
  () => !expanded.value && outputLines.value.length > TRUNCATE_LINE_COUNT,
);
const visibleLines = computed(() =>
  truncated.value ? outputLines.value.slice(-TRUNCATE_LINE_COUNT) : outputLines.value,
);
const isScrollable = computed(() => visibleLines.value.length > OUTPUT_SCROLL_LINE_COUNT);
const outputStyle = { '--tool-output-visible-lines': String(OUTPUT_SCROLL_LINE_COUNT) };
</script>

<template>
  <div class="bb-code tool-output-block" :class="{ scroll: isScrollable }" :style="outputStyle">
    <div v-if="outputLines.length === 0 && emptyText" class="bb-empty">{{ emptyText }}</div>
    <button v-if="truncated" class="truncate-toggle" type="button" @click="expanded = true">
      {{ t('tools.output.showAll', { count: outputLines.length }) }}
    </button>
    <div v-for="(line, i) in visibleLines" :key="i">{{ line }}</div>
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
.truncate-toggle {
  display: block;
  width: 100%;
  margin: 0 0 var(--space-2);
  padding: var(--space-1) 0;
  border: none;
  border-bottom: 1px dashed var(--color-line);
  background: transparent;
  color: var(--color-accent);
  font: var(--text-xs) var(--font-ui);
  cursor: pointer;
  text-align: center;
}
.truncate-toggle:hover {
  text-decoration: underline;
}
</style>
