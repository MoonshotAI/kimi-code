<!-- apps/kimi-web/src/components/ui/Textarea.vue -->
<!-- Design-system §03 Textarea: same surface/focus as Input, multi-line. -->
<script setup lang="ts">
withDefaults(defineProps<{
  modelValue?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  error?: boolean;
}>(), {
  rows: 3,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <textarea
    class="ui-textarea"
    :class="{ 'has-error': error }"
    :value="modelValue"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    @input="onInput"
    @focus="$emit('focus', $event)"
    @blur="$emit('blur', $event)"
  />
</template>

<style scoped>
.ui-textarea {
  width: 100%;
  min-height: 84px;
  resize: vertical;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  padding: 10px 12px;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-textarea::placeholder { color: var(--color-text-faint); }
.ui-textarea:hover:not(:disabled):not(:focus) { border-color: var(--color-line-strong); }
.ui-textarea:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.ui-textarea:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-textarea[readonly] { background: var(--color-surface-sunken); }
.ui-textarea.has-error { border-color: var(--color-danger); }
.ui-textarea.has-error:focus { box-shadow: 0 0 0 3px var(--color-danger-soft); }
</style>
