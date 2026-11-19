<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  modelValue?: string;
  rows?: number;
  autosize?: boolean;
  size?: 'sm' | 'md';
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  error?: boolean;
  resize?: boolean;
}>(), {
  rows: 3,
  size: 'md',
  resize: true,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
  if (props.autosize) resizeToContent();
}

const textareaRef = ref<HTMLTextAreaElement | null>(null);
function resizeToContent(): void {
  const el = textareaRef.value;
  if (!props.autosize || !el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}
let observer: ResizeObserver | undefined;
let previousWidth = 0;
watch(() => [props.modelValue, props.autosize], () => void nextTick(resizeToContent));
onMounted(() => {
  if (!textareaRef.value) return;
  observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width ?? 0; if (width !== previousWidth) { previousWidth = width; resizeToContent(); } });
  observer.observe(textareaRef.value);
  void document.fonts?.ready.then(resizeToContent);
  resizeToContent();
});
onUnmounted(() => observer?.disconnect());
defineExpose({ el: textareaRef });
</script>

<template>
  <textarea
    ref="textareaRef"
    class="ui-textarea"
    :class="[{ 'has-error': error, 'no-resize': !resize || autosize, 'is-autosize': autosize }, `ui-textarea--${size}`]"
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
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-xs);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  padding: 10px 12px;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-textarea--sm { min-height: 4rem; padding: var(--space-2); font-size: var(--text-sm); }
.ui-textarea::placeholder { color: var(--color-text-faint); }
.ui-textarea.is-autosize { overflow: hidden; }
.ui-textarea.no-resize { resize: none; }
.ui-textarea:hover:not(:disabled):not(:focus) { border-color: var(--color-line-strong); }
.ui-textarea:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--p-focus-ring); }
.ui-textarea:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-textarea[readonly] { background: var(--color-surface-sunken); }
.ui-textarea.has-error { border-color: var(--color-danger); }
.ui-textarea.has-error:focus { box-shadow: 0 0 0 3px var(--color-danger-soft); }
</style>
