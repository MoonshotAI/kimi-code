<!-- apps/kimi-web/src/components/ui/Input.vue -->
<!-- Design-system §03 Input: 38px (sm 32px), radius md, raised surface, blue focus ring. -->
<script setup lang="ts">
import { ref } from 'vue';

withDefaults(defineProps<{
  modelValue?: string | number;
  size?: 'sm' | 'md';
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  error?: boolean;
}>(), {
  size: 'md',
  type: 'text',
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();

const el = ref<HTMLInputElement>();

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}

// Expose the underlying element so call sites that need to programmatically
// focus / select (e.g. inline rename fields) can do so via the template ref.
function focus() {
  el.value?.focus();
}
function select() {
  el.value?.select();
}
defineExpose({ focus, select, el });
</script>

<template>
  <input
    ref="el"
    class="ui-input"
    :class="[`ui-input--${size}`, { 'has-error': error }]"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    @input="onInput"
    @focus="$emit('focus', $event)"
    @blur="$emit('blur', $event)"
  />
</template>

<style scoped>
.ui-input {
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
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-input--md { height: 38px; }
.ui-input--sm { height: 32px; font-size: var(--text-sm); border-radius: var(--radius-sm); }
.ui-input::placeholder { color: var(--color-text-faint); }
.ui-input:hover:not(:disabled):not(:focus) { border-color: var(--color-line-strong); }
.ui-input:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.ui-input:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-input[readonly] { background: var(--color-surface-sunken); }
.ui-input.has-error { border-color: var(--color-danger); }
.ui-input.has-error:focus { box-shadow: 0 0 0 3px var(--color-danger-soft); }
</style>
