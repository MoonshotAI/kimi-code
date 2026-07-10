<!-- apps/kimi-web/src/components/ui/Avatar.vue -->
<!-- Design-system §03 Avatar: 32px (sm 24px), radius md. Slot holds initials or an icon. -->
<script setup lang="ts">
withDefaults(defineProps<{ size?: 'sm' | 'md' }>(), { size: 'md' });
</script>

<template>
  <span class="ui-avatar" :class="`ui-avatar--${size}`"><slot /></span>
</template>

<style scoped>
.ui-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  overflow: hidden;
}
.ui-avatar--md { width: 32px; height: 32px; font-size: var(--text-sm); }
.ui-avatar--sm { width: 24px; height: 24px; font-size: var(--text-xs); border-radius: var(--radius-sm); }
.ui-avatar :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ui-avatar--sm :deep(svg) { width: 13px; height: 13px; }
</style>
