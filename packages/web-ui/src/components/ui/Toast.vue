<!-- apps/kimi-web/src/components/ui/Toast.vue -->
<!-- Design-system §03 Toast: floating notice = status icon + title + description
     + close. Variants color the icon (info / success / warning / danger). The
     default slot carries extra body content (action links, detail panels…). -->
<script setup lang="ts">
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';

withDefaults(defineProps<{
  variant?: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  message?: string;
  dismissLabel?: string;
}>(), {
  variant: 'info',
  dismissLabel: 'Dismiss',
});

defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div class="ui-toast" :class="`ui-toast--${variant}`">
    <span class="ui-toast__icon" aria-hidden="true">
      <slot name="icon">
        <Icon v-if="variant === 'success'" name="check" />
        <Icon v-else-if="variant === 'danger'" name="close" />
        <Icon v-else-if="variant === 'warning'" name="alert-triangle" />
        <Icon v-else name="info" />
      </slot>
    </span>
    <div class="ui-toast__body">
      <div class="ui-toast__title">{{ title }}</div>
      <div v-if="message" class="ui-toast__msg">{{ message }}</div>
      <slot />
    </div>
    <IconButton class="ui-toast__close" size="sm" :label="dismissLabel" @click="$emit('dismiss')">
      <Icon name="close" size="sm" />
    </IconButton>
  </div>
</template>

<style scoped>
.ui-toast {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  width: 360px;
  max-width: 100%;
  padding: 13px 14px;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  font-family: var(--font-ui);
  line-height: 1.45;
}
.ui-toast__icon {
  flex: none;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: var(--radius-full);
  display: grid;
  place-items: center;
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.ui-toast__icon svg { width: 12px; height: 12px; }
.ui-toast--success .ui-toast__icon { background: var(--color-success-soft); color: var(--color-success); }
.ui-toast--warning .ui-toast__icon { background: var(--color-warning-soft); color: var(--color-warning); }
.ui-toast--danger .ui-toast__icon { background: var(--color-danger-soft); color: var(--color-danger); }
.ui-toast--danger { border-color: color-mix(in srgb, var(--color-danger) 35%, transparent); }
.ui-toast__body { flex: 1; min-width: 0; }
.ui-toast__title {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.ui-toast__msg {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.ui-toast--danger .ui-toast__msg { color: var(--color-danger); }
.ui-toast__close { flex: none; margin: -3px -4px 0 0; }
</style>
