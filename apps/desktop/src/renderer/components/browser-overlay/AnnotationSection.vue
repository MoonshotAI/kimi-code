<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';
defineProps<{ title: string; detail?: string }>();
const open = ref(false);
</script>
<template>
  <section class="annotation-section">
    <button class="section-heading" type="button" :aria-expanded="open" @click="open = !open"><Icon name="chevron-right" size="sm" :class="{ rotated: open }" /><span>{{ title }}</span><span v-if="detail" class="section-detail">{{ detail }}</span></button>
    <div class="section-expansion" :class="{ open }" :inert="!open" :aria-hidden="!open"><div class="section-clip"><div class="section-content"><slot /></div></div></div>
  </section>
</template>
<style scoped>
.annotation-section { border-top: var(--p-hairline) solid var(--color-line); }
.section-heading { display: flex; align-items: center; gap: var(--space-1); width: 100%; min-height: 2.25rem; padding: 0; border: 0; background: none; text-align: start; font: inherit; font-size: var(--text-sm); font-weight: var(--weight-section-label); color: var(--color-text-muted); cursor: pointer; user-select: none; }
.section-heading:focus-visible { outline: none; box-shadow: inset var(--p-focus-ring); }
.section-heading:hover { color: var(--color-text); }
.section-heading :deep(svg) { flex: none; transition: transform var(--duration-base) var(--ease-out); }
.section-heading .rotated { transform: rotate(90deg); }
.section-detail { margin-left: auto; font-size: var(--text-xs); font-weight: var(--weight-caption); font-variant-numeric: tabular-nums; }
.section-expansion { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--duration-base) var(--ease-out); }
.section-expansion.open { grid-template-rows: 1fr; }
.section-clip { min-height: 0; overflow: hidden; }
.section-content { padding-block: var(--space-2); }
@media (prefers-reduced-motion: reduce) { .section-expansion, .section-heading :deep(svg) { transition: none; } }
</style>
