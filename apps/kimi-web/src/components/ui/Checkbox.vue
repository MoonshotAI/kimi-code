<!-- apps/kimi-web/src/components/ui/Checkbox.vue -->
<!-- Design-system §03 Checkbox: 17×17, filled accent + white check when on. -->
<script setup lang="ts">
import Icon from './Icon.vue';

defineProps<{
  modelValue: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <label class="ui-check" :class="{ 'is-on': modelValue, 'is-disabled': disabled }">
    <input
      class="ui-check__input"
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="ui-check__box" aria-hidden="true">
      <Icon v-if="modelValue" name="check" size="md" />
    </span>
    <span v-if="$slots.default" class="ui-check__label"><slot /></span>
  </label>
</template>

<style scoped>
.ui-check { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; }
.ui-check.is-disabled { opacity: 0.5; cursor: not-allowed; }
.ui-check__input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.ui-check__box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  flex: none;
  border: 1.5px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text-on-accent);
  transition: background var(--duration-base) var(--ease-out),
    border-color var(--duration-base) var(--ease-out);
}
.ui-check.is-on .ui-check__box { background: var(--color-accent); border-color: var(--color-accent); }
.ui-check__input:focus-visible + .ui-check__box { box-shadow: var(--p-focus-ring); }
.ui-check__box svg { width: 12px; height: 12px; }
.ui-check__label { font-family: var(--font-ui); font-size: var(--text-base); color: var(--color-text); }
</style>
