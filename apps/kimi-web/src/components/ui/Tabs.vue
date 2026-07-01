<!-- apps/kimi-web/src/components/ui/Tabs.vue -->
<!-- Design-system §03 Tabs: underlined tab list. -->
<script setup lang="ts">
defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="ui-tabs" role="tablist">
    <button
      v-for="opt in options"
      :key="opt.value"
      class="ui-tabs__item"
      :class="{ 'is-on': opt.value === modelValue }"
      type="button"
      role="tab"
      :aria-selected="opt.value === modelValue"
      @click="emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.ui-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--color-line); }
.ui-tabs__item {
  padding: var(--space-2) 14px;
  margin-bottom: -1px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out),
    border-color var(--duration-base) var(--ease-out);
}
.ui-tabs__item:hover:not(.is-on) { color: var(--color-text); }
.ui-tabs__item.is-on { color: var(--color-accent); border-bottom-color: var(--color-accent); }
.ui-tabs__item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); border-radius: var(--radius-xs); }
</style>
