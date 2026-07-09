<!-- Token-styled keyboard shortcut. Keeps the semantic <kbd> element reusable
     across compact UI surfaces. -->
<template>
  <kbd class="shortcut-key">
    <slot />
  </kbd>
</template>

<style scoped>
.shortcut-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0 var(--space-1);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-xs);
  line-height: var(--leading-tight);
}
</style>
