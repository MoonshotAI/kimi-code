<!-- apps/kimi-web/src/components/ui/Banner.vue -->
<!-- Design-system §03 Banner: inline notice, info / warning / danger.
     Status color only on the icon to avoid large color washes. -->
<script setup lang="ts">
import Icon from './Icon.vue';

withDefaults(defineProps<{ variant?: 'info' | 'warning' | 'danger' }>(), { variant: 'info' });
</script>

<template>
  <div class="ui-banner" :class="`ui-banner--${variant}`" role="status">
    <span class="ui-banner__icon" aria-hidden="true">
      <slot name="icon">
        <Icon v-if="variant === 'info'" name="info" size="md" />
        <Icon v-else name="alert-triangle" size="md" />
      </slot>
    </span>
    <span class="ui-banner__text"><slot /></span>
  </div>
</template>

<style scoped>
.ui-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.ui-banner__icon { display: inline-flex; flex: none; }
.ui-banner__icon svg { width: 18px; height: 18px; }
.ui-banner--info { background: var(--color-accent-soft); border-color: var(--color-accent-bd); }
.ui-banner--warning { background: var(--color-warning-soft); border-color: var(--color-warning-bd); }
.ui-banner--danger { background: var(--color-danger-soft); border-color: var(--color-danger-bd); }
.ui-banner--info .ui-banner__icon { color: var(--color-accent); }
.ui-banner--warning .ui-banner__icon { color: var(--color-warning); }
.ui-banner--danger .ui-banner__icon { color: var(--color-danger); }
</style>
