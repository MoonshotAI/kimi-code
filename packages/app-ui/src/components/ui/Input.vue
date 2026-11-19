<script setup lang="ts">
import { ref } from 'vue';

withDefaults(defineProps<{
  modelValue?: string | number;
  size?: 'xs' | 'sm' | 'md';
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  error?: boolean;
  embedded?: boolean;
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
    :class="[`ui-input--${size}`, { 'has-error': error, 'is-embedded': embedded }]"
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
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-overlay);
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
.ui-input--xs { height: var(--space-6); padding-inline: var(--space-2); font-size: var(--text-sm); border-radius: var(--radius-sm); }
.ui-input--sm { height: 32px; font-size: var(--text-sm); border-radius: var(--radius-sm); }
.ui-input.is-embedded { border: none; background: transparent; box-shadow: none; padding-inline: 0; }
.ui-input.is-embedded:focus { box-shadow: none; }
.ui-input::placeholder { color: var(--color-text-faint); }
.ui-input:hover:not(:disabled):not(:focus) { border-color: var(--color-line-strong); }
.ui-input:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.ui-input:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-input[readonly] { background: var(--color-surface-sunken); }
.ui-input.has-error { border-color: var(--color-danger); }
.ui-input.has-error:focus { box-shadow: 0 0 0 3px var(--color-danger-soft); }
</style>
