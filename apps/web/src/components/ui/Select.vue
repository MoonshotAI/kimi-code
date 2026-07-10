<!-- apps/kimi-web/src/components/ui/Select.vue -->
<!-- Design-system §03 Select: same sizing/surface/focus as Input. -->
<script setup lang="ts">
withDefaults(defineProps<{
  modelValue?: string | number;
  size?: 'sm' | 'md';
  disabled?: boolean;
  error?: boolean;
}>(), {
  size: 'md',
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onChange(event: Event) {
  emit('update:modelValue', (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <select
    class="ui-select"
    :class="[`ui-select--${size}`, { 'has-error': error }]"
    :value="modelValue"
    :disabled="disabled"
    @change="onChange"
  >
    <slot />
  </select>
</template>

<style scoped>
.ui-select {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  width: 100%;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background-color: var(--color-surface-raised);
  /* Chevron matches the design-system `chevron-down` icon (16×16, 1.5px stroke).
     Inline SVG can't read CSS vars, so the stroke is hardcoded per theme below. */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%236b7280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right var(--space-3) center;
  background-size: 16px 16px;
  box-shadow: var(--shadow-xs);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  padding: 0 var(--space-3);
  padding-right: calc(var(--space-3) + 16px + var(--space-2));
  cursor: pointer;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-select--md { height: 38px; }
.ui-select--sm { height: 32px; font-size: var(--text-sm); }
.ui-select:hover:not(:disabled):not(:focus) { border-color: var(--color-line-strong); }
.ui-select:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.ui-select:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-select.has-error { border-color: var(--color-danger); }
.ui-select.has-error:focus { box-shadow: 0 0 0 3px var(--color-danger-soft); }

/* Dark-theme chevron (explicit choice). */
html[data-color-scheme="dark"] .ui-select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%239aa0a8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
}
/* Dark-theme chevron (follow OS). */
@media (prefers-color-scheme: dark) {
  html[data-color-scheme="system"] .ui-select {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%239aa0a8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
  }
}
</style>
