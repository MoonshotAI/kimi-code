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
  width: 100%;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  padding: 0 var(--space-3);
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
</style>
