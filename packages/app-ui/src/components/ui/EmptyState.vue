<!-- apps/kimi-web/src/components/ui/EmptyState.vue -->
<!-- Design-system §03 EmptyState: centered placeholder for empty lists/panels. -->
<script setup lang="ts">
defineProps<{ title?: string; hint?: string }>();
</script>

<template>
  <div class="ui-empty">
    <span v-if="$slots.icon" class="ui-empty__icon" aria-hidden="true"><slot name="icon" /></span>
    <div v-if="title" class="ui-empty__title">{{ title }}</div>
    <div v-if="hint" class="ui-empty__hint">{{ hint }}</div>
    <slot />
  </div>
</template>

<style scoped>
.ui-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  text-align: center;
  color: var(--color-text-muted);
}
.ui-empty__icon { color: var(--color-text-faint); }
.ui-empty__icon :deep(svg) { width: 48px; height: 48px; }
.ui-empty__title { font-size: var(--text-base); font-weight: var(--weight-medium); color: var(--color-text-muted); }
.ui-empty__hint { font-size: var(--text-sm); color: var(--color-text-muted); }
</style>
