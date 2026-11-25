<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';

defineOptions({ inheritAttrs: false });

defineProps<{ placeholder: string }>();

const query = defineModel<string>({ required: true });

const inputRef = ref<HTMLInputElement | null>(null);

function focus(options?: FocusOptions): void {
  inputRef.value?.focus(options);
}

defineExpose({ focus });
</script>

<template>
  <div class="menu-search">
    <Icon name="search" size="sm" />
    <input
      ref="inputRef"
      v-model="query"
      class="menu-search-input"
      type="text"
      :placeholder="placeholder"
      :aria-label="placeholder"
      autocomplete="off"
      v-bind="$attrs"
    />
  </div>
</template>

<style scoped>
.menu-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  margin: 0 var(--space-1);
  padding: var(--space-2) var(--space-1);
  border-bottom: var(--p-hairline) solid var(--color-line);
  color: var(--color-text-faint);
}
.menu-search:focus-within {
  border-bottom-color: var(--color-line-strong);
}
.menu-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}
.menu-search-input::placeholder {
  color: var(--color-text-faint);
}
</style>
