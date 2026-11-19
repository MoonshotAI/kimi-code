<script setup lang="ts">
import { computed } from 'vue';
import { formatShortcutKeys } from '@moonshot-ai/app-core/lib';
import Icon from './Icon.vue';
import Spinner from './Spinner.vue';

const props = withDefaults(defineProps<{
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

interface CapPart {
  id: string;
  text?: string;
  icon?: string;
}

const capParts = computed<CapPart[]>(() =>
  formatShortcutKeys(props.keys).flatMap((cap, index): CapPart[] => {
    const part: CapPart = cap.icon === undefined ? { id: cap.name, text: cap.text } : { id: cap.name, icon: cap.icon };
    return index === 0 ? [part] : [{ id: `plus-${index}`, icon: 'key-plus' }, part];
  }),
);
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
    <span v-if="capParts.length > 0" class="ui-button__cap" :class="{ 'ui-button__cap--combo': capParts.length > 1 }" aria-hidden="true">
      <template v-for="part in capParts" :key="part.id">
        <span v-if="part.icon === undefined" class="ui-button__cap-text">{{ part.text }}</span>
        <span v-else class="ui-button__cap-key"><Icon :name="part.icon" size="md" /></span>
      </template>
    </span>
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

.ui-button__content { display: inline-flex; align-items: center; gap: var(--space-2); }

.ui-button__content :deep(svg) { flex: none; }
.ui-button__content :deep(svg:not([width])) { width: 1em; height: 1em; }
.ui-button__icon { flex: none; }

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

.ui-button__cap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 24px;
  height: 18px;
  padding: 0 3px;
  border-radius: var(--radius-xs);
  background: var(--color-fill-1);
  font-size: var(--text-xs);
  line-height: 18px;
}
.ui-button--primary .ui-button__cap {
  background: var(--color-fill-on-inverted);
}
.ui-button__cap--combo {
  padding: 0 4px;
}
.ui-button__cap-key {
  display: inline-flex;
  justify-content: center;
  flex: none;
}
.ui-button__cap--combo .ui-button__cap-key {
  width: 12px;
}
.ui-button__cap--combo .ui-button__cap-text + .ui-button__cap-key {
  margin-left: 2px;
}
.ui-button__cap :deep(.kw-icon) {
  flex: none;
  width: 18px;
  height: 18px;
}
</style>
