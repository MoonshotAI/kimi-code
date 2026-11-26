<script setup lang="ts">
import Icon from './Icon.vue';
import Kbd from './Kbd.vue';
import Spinner from './Spinner.vue';

withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'text';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  type?: 'button' | 'submit' | 'reset';
  icon?: string;
  trailingIcon?: string;
  keys?: readonly string[];
}>(), {
  variant: 'primary',
  size: 'md',
  type: 'button',
  icon: '',
  trailingIcon: '',
  keys: () => [],
});
</script>

<template>
  <button
    class="ui-button"
    :class="[`ui-button--${variant}`, `ui-button--${size}`, { 'is-loading': loading }]"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <Spinner v-if="loading" size="sm" class="ui-button__spinner" />
    <span class="ui-button__content">
      <Icon v-if="icon" class="ui-button__icon" :name="icon" size="sm" aria-hidden="true" />
      <slot />
      <Icon v-if="trailingIcon" class="ui-button__icon" :name="trailingIcon" size="sm" aria-hidden="true" />
    </span>
    <Kbd v-if="keys.length > 0" class="ui-button__kbd" :keys="keys" variant="button" aria-hidden="true" />
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: var(--p-hairline) solid transparent;
  border-radius: var(--radius-md);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--duration-base) var(--ease-out),
    border-color var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.ui-button:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring-strong);
}
.ui-button:not(:disabled):active { transform: scale(0.98); }
.ui-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.ui-button--xs { height: 24px; padding: 0 var(--space-2); font-size: var(--text-xs); border-radius: var(--radius-sm); }
.ui-button--sm { height: 30px; padding: 0 var(--space-3); font-size: var(--text-sm); border-radius: var(--radius-sm); }
.ui-button--md { height: 36px; padding: 0 var(--space-4); font-size: var(--text-base); }
.ui-button--lg { height: 42px; padding: 0 var(--space-5); font-size: 15px; border-radius: var(--radius-lg); }

.ui-button--xs:has(.ui-kbd--button) { padding-right: calc(var(--space-1) - var(--p-hairline)); }
.ui-button--sm:has(.ui-kbd--button) { padding-right: calc(var(--space-1-5) - var(--p-hairline)); }
.ui-button--md:has(.ui-kbd--button) { padding-right: calc(var(--space-2) - var(--p-hairline)); }
.ui-button--lg:has(.ui-kbd--button) { padding-right: calc(var(--space-3) - var(--p-hairline)); }
.ui-button:has(.ui-kbd--button) { gap: var(--space-1); }

.ui-button__content { display: inline-flex; align-items: center; gap: var(--space-2); }
.ui-button__content:has(.ui-kbd--button) { gap: var(--space-1); }

.ui-button__content :deep(svg) { flex: none; }
.ui-button__content :deep(svg:not([width])) { width: 1em; height: 1em; }
.ui-button__icon { flex: none; }
.ui-button__kbd { flex: none; }

.ui-button--primary {
  background: var(--color-send-bg);
  color: var(--color-send-icon);
  border-color: transparent;
  box-shadow: var(--shadow-xs);
}
.ui-button--primary:not(:disabled):hover { background: var(--color-send-bg-hover); }
.ui-button--primary:disabled {
  background: var(--color-send-bg-disabled);
  color: var(--color-send-icon-disabled);
  opacity: 1;
}

.ui-button--secondary {
  background: var(--color-surface-raised);
  color: var(--color-text);
  border-color: var(--color-line-strong);
  box-shadow: var(--shadow-xs);
}
.ui-button--secondary:not(:disabled):hover { border-color: var(--color-line-strong); background: var(--color-hover); }

.ui-button--ghost {
  background: transparent;
  color: var(--color-text-muted);
  border-color: transparent;
}
.ui-button--ghost:not(:disabled):hover { background: var(--color-hover); color: var(--color-text-strong); }

.ui-button--danger {
  background: var(--color-surface-raised);
  color: var(--color-danger);
  border-color: var(--color-danger-bd);
  box-shadow: var(--shadow-xs);
}
.ui-button--danger:not(:disabled):hover { background: var(--color-danger-soft); }

.ui-button--text {
  height: auto;
  padding: 0;
  background: transparent;
  border-color: transparent;
  border-radius: var(--radius-xs);
  color: var(--color-text-muted);
  font-size: inherit;
  font-weight: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.ui-button--text:not(:disabled):hover { color: var(--color-text); }
.ui-button--text:not(:disabled):active { transform: none; }

.ui-button.is-loading .ui-button__content { opacity: 0.7; }
.ui-button .ui-button__spinner { flex: none; color: inherit; }
.ui-button__spinner :deep(.ui-spinner__track) { opacity: 0.35; }
</style>
