<script setup lang="ts">
import { Icon } from '@moonshot-ai/app-ui';

defineProps<{
  icon: string;
  title: string;
  meta?: string;
}>();
</script>

<template>
  <span class="wp-head-tab">
    <Icon :name="icon" size="md" />
    <span>{{ title }}</span>
    <span v-if="meta" class="wp-head-meta">{{ meta }}</span>
  </span>
  <span v-if="$slots.actions" class="wp-head-actions">
    <slot name="actions" />
  </span>
</template>

<style scoped>
.wp-head-tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: round(calc(var(--text-base) * 1.42), 1px);
  white-space: nowrap;
  flex: none;
}
.wp-head-tab :deep(svg) {
  width: var(--p-ic-dock);
  height: var(--p-ic-dock);
}
.wp-head-meta {
  color: var(--color-text-muted);
  font-weight: var(--weight-regular);
  text-autospace: normal;
}
.wp-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  flex: none;
}
.wp-head-actions :deep(.ui-icon-button) {
  width: var(--icon-button-xs);
  height: var(--icon-button-xs);
  border-radius: var(--radius-md);
}
.wp-head-actions :deep(.ui-icon-button svg) {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
}
@media (max-width: 480px) {
  .wp-head-actions {
    flex-basis: 100%;
    margin-left: 0;
  }
}
@media (hover: none) {
  .wp-head-actions :deep(.ui-seg__item) {
    min-height: var(--touch-target-min);
  }
}
@media (max-width: 640px), (hover: none) {
  .wp-head-actions :deep(.ui-seg__item) {
    height: var(--touch-target-min);
  }
  .wp-head-actions :deep(.ui-icon-button) {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
  }
  .wp-head-actions :deep(.fc-trigger) {
    min-height: var(--touch-target-min);
  }
}
</style>
