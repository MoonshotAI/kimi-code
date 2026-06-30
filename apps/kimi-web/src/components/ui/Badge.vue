<!-- apps/kimi-web/src/components/ui/Badge.vue -->
<!-- Design-system §03 Badge: status badge with optional status dot.
     variant: neutral | info | success | warning | danger | solid -->
<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'solid';
  size?: 'sm' | 'md';
  dot?: boolean;
}>(), {
  variant: 'neutral',
  size: 'md',
});
</script>

<template>
  <span class="ui-badge" :class="[`ui-badge--${variant}`, `ui-badge--${size}`]">
    <span v-if="dot" class="ui-badge__dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-full);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
}
.ui-badge--md { height: 22px; padding: 0 9px; font-size: var(--text-xs); }
.ui-badge--sm { height: 18px; padding: 0 7px; font-size: 11px; }

.ui-badge__dot { width: 6px; height: 6px; border-radius: var(--radius-full); background: currentColor; flex: none; }

.ui-badge--neutral { background: var(--color-surface-sunken); color: var(--color-text-muted); border-color: var(--color-line); }
.ui-badge--info { background: var(--color-accent-soft); color: var(--color-accent-hover); border-color: var(--color-accent-bd); }
.ui-badge--success { background: var(--color-success-soft); color: var(--color-success); border-color: var(--color-success-bd); }
.ui-badge--warning { background: var(--color-warning-soft); color: var(--color-warning); border-color: var(--color-warning-bd); }
.ui-badge--danger { background: var(--color-danger-soft); color: var(--color-danger); border-color: var(--color-danger-bd); }
.ui-badge--solid { background: var(--color-text); color: var(--color-bg); }
</style>
