<!-- apps/kimi-web/src/components/chat/StatusGlyph.vue -->
<!-- Shared status glyph for dock list rows (todo + background bash/subagent tasks).
     One symbol per state, colored by state — keeps the two lists visually identical. -->
<script setup lang="ts">
export type StatusGlyphStatus = 'pending' | 'run' | 'done' | 'fail';

const props = defineProps<{ status: StatusGlyphStatus }>();

const GLYPH: Record<StatusGlyphStatus, string> = {
  pending: '○',
  run: '●',
  done: '✓',
  fail: '✗',
};
</script>

<template>
  <span class="status-glyph" :class="`s-${props.status}`" aria-hidden="true">{{ GLYPH[props.status] }}</span>
</template>

<style scoped>
.status-glyph {
  flex: none;
  width: 16px;
  font-size: var(--text-base);
  line-height: 1;
  text-align: center;
  user-select: none;
}
.status-glyph.s-run { color: var(--color-accent); font-weight: 500; }
.status-glyph.s-done { color: var(--color-success); }
.status-glyph.s-fail { color: var(--color-danger); }
.status-glyph.s-pending { color: var(--color-text-faint); }
</style>
