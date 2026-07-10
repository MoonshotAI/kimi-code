<!-- apps/kimi-web/src/components/ui/Button.vue -->
<!-- Design-system §03 Button: 5 semantic variants × 3 sizes.
     variant: primary | secondary | ghost | danger | danger-soft
     size:    sm | md | lg -->
<script setup lang="ts">
import Spinner from './Spinner.vue';

withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  type?: 'button' | 'submit' | 'reset';
}>(), {
  variant: 'primary',
  size: 'md',
  type: 'button',
});
</script>

<template>
  <!-- Native click (and modifiers like .stop/.prevent) fall through to the
       inner <button> via inheritAttrs — so call sites can write
       <Button @click.stop="…"> exactly like a native button. -->
  <button
    class="ui-button"
    :class="[`ui-button--${variant}`, `ui-button--${size}`, { 'is-loading': loading }]"
    :type="type"
    :disabled="disabled || loading"
  >
    <Spinner v-if="loading" size="sm" class="ui-button__spinner" />
    <span class="ui-button__content"><slot /></span>
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px solid transparent;
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

/* sizes */
.ui-button--sm { height: 30px; padding: 0 var(--space-3); font-size: var(--text-sm); border-radius: var(--radius-sm); }
.ui-button--md { height: 36px; padding: 0 var(--space-4); font-size: var(--text-base); }
.ui-button--lg { height: 42px; padding: 0 var(--space-5); font-size: 15px; border-radius: var(--radius-lg); }

/* icon + label sit on one row; the svg reset makes <svg> display:block, which
   would otherwise stack it above the text. */
.ui-button__content { display: inline-flex; align-items: center; gap: var(--space-2); }

/* slotted icons: default to 1em (scale with the button's font size, like MUI/Ant);
   an icon that declares its own width keeps it (opt-out, same idea as shadcn's
   not([class*='size-']) — this app uses the width attribute instead of a class). */
.ui-button__content :deep(svg) { flex: none; }
.ui-button__content :deep(svg:not([width])) { width: 1em; height: 1em; }

/* variants */
.ui-button--primary {
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  border-color: var(--color-accent);
  box-shadow: var(--shadow-xs);
}
.ui-button--primary:not(:disabled):hover { background: var(--color-accent-hover); border-color: var(--color-accent-hover); }

.ui-button--secondary {
  background: var(--color-surface-raised);
  color: var(--color-text);
  border-color: var(--color-line-strong);
  box-shadow: var(--shadow-xs);
}
.ui-button--secondary:not(:disabled):hover { border-color: var(--color-line-strong); background: var(--color-surface-sunken); }

.ui-button--ghost {
  background: transparent;
  color: var(--color-text-muted);
  border-color: transparent;
}
.ui-button--ghost:not(:disabled):hover { background: var(--color-surface-sunken); color: var(--color-text); }

.ui-button--danger {
  background: var(--color-danger);
  color: var(--color-text-on-accent);
  border-color: var(--color-danger);
  box-shadow: var(--shadow-xs);
}
.ui-button--danger:not(:disabled):hover { filter: brightness(0.96); }

.ui-button--danger-soft {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-color: var(--color-danger-bd);
}
.ui-button--danger-soft:not(:disabled):hover { background: var(--color-danger); color: var(--color-text-on-accent); border-color: var(--color-danger); }

.ui-button.is-loading .ui-button__content { opacity: 0.7; }
.ui-button .ui-button__spinner { flex: none; color: inherit; }
.ui-button__spinner :deep(.ui-spinner__track) { opacity: 0.35; }
</style>
