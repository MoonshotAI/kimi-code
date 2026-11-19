<script setup lang="ts">
import HighlightedCode from '../HighlightedCode.vue';

defineProps<{ json: string }>();

const MAX_HIGHLIGHT_CHARS = 100_000;
</script>

<template>
  <HighlightedCode v-if="json.length <= MAX_HIGHLIGHT_CHARS" :code="json" path="entry.json" :framed="false" />
  <pre v-else class="insp-json-plain">{{ json }}</pre>
</template>

<style scoped>
.insp-json-plain {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--color-text-muted);
  white-space: pre;
  user-select: text;
}
</style>
