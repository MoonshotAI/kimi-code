<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';
import { useImeComposition } from '../../composables/useImeComposition';

defineProps<{
  modelValue: string;
  placeholder?: string;
  ariaLabel?: string;
  divider?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  navigate: [key: 'ArrowDown' | 'ArrowUp'];
  escape: [];
}>();

const input = ref<HTMLInputElement>();
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function focus(): void {
  input.value?.focus();
}

defineExpose({ focus });

function onKeydown(event: KeyboardEvent): void {
  if (isComposingKeyEvent(event)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('escape');
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    emit('navigate', event.key);
  }
}
</script>

<template>
  <div class="ui-menu-search" :class="{ 'ui-menu-search--divider': divider }">
    <Icon name="search" size="sm" />
    <input
      ref="input"
      class="ui-menu-search__input"
      type="text"
      autocomplete="off"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="ariaLabel ?? placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @compositionstart="handleCompositionStart"
      @compositionend="handleCompositionEnd"
      @keydown="onKeydown"
    />
  </div>
</template>

<style scoped>
.ui-menu-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  padding: var(--menu-item-padding-block) var(--menu-item-padding-inline);
  color: var(--color-text-faint);
}
.ui-menu-search--divider {
  margin-bottom: var(--menu-pad);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.ui-menu-search--divider:focus-within { border-bottom-color: var(--color-line-strong); }
.ui-menu-search--divider:first-child {
  margin-top: calc(-1 * var(--menu-pad));
  padding-block: calc(var(--menu-item-padding-block) + var(--menu-pad) / 2);
}
.ui-menu-search > :deep(svg) { flex: none; }
.ui-menu-search__input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-tight);
}
.ui-menu-search__input::placeholder { color: var(--color-text-faint); }
</style>
