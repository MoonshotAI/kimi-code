<script setup lang="ts">
import Icon from './Icon.vue';

defineProps<{
  modelValue: string;
  options: { value: string; label: string; icon?: string; swatch?: string }[];
  size?: 'xs' | 'sm' | 'md';
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="ui-seg" :class="[`ui-seg--${size ?? 'md'}`, { 'ui-seg--disabled': disabled }]" role="tablist">
    <button
      v-for="opt in options"
      :key="opt.value"
      class="ui-seg__item"
      :class="{ 'is-on': opt.value === modelValue }"
      :data-icon="opt.icon"
      type="button"
      role="tab"
      :aria-selected="opt.value === modelValue"
      :disabled="disabled"
      @click="emit('update:modelValue', opt.value)"
    >
      <Icon v-if="opt.icon" class="ui-seg__icon" :name="opt.icon" size="sm" />
      <span v-if="opt.swatch" class="ui-seg__swatch" :style="{ backgroundColor: opt.swatch }" />
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.ui-seg {
  position: relative;
  display: inline-flex;
  flex-wrap: wrap;
  max-width: 100%;
  box-sizing: border-box;
  gap: 2px;
  padding: 2px;
  background: var(--color-surface-sunken);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
}
.ui-seg__item {
  position: relative;
  z-index: 1;
  display: inline-flex;
  flex: 1 0 auto;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  cursor: pointer;
  line-height: 1;
  white-space: nowrap;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.ui-seg__swatch {
  width: 7px;
  height: 7px;
  border: var(--p-hairline) solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 50%;
  flex: none;
}
.ui-seg__icon { flex: none; }
.ui-seg--md .ui-seg__item { padding: 5px var(--space-3); font-size: var(--text-sm); }
.ui-seg--sm .ui-seg__item { height: 24px; padding: 0 var(--space-2); font-size: var(--text-sm); }
.ui-seg--xs .ui-seg__item { height: 20px; padding: 0 var(--space-2); font-size: var(--text-xs); }
.ui-seg__item:hover:not(.is-on):not(:disabled) { color: var(--color-text); }
.ui-seg--disabled { opacity: 0.5; }
.ui-seg__item:disabled { cursor: not-allowed; }
.ui-seg__item.is-on {
  color: var(--color-text);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
}
.ui-seg__item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
</style>
