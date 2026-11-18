<script setup lang="ts">
defineProps<{
  modelValue: boolean;
  disabled?: boolean;
  label?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <button
    class="ui-switch"
    :class="{ 'is-on': modelValue }"
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="ui-switch__thumb" />
  </button>
</template>

<style scoped>
.ui-switch {
  position: relative;
  width: 36px;
  height: 20px;
  flex: none;
  padding: 0;
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-full);
  background: var(--color-line-strong);
  cursor: pointer;
  transition: background var(--duration-slow) var(--ease-in-out);
}
.ui-switch.is-on { background: var(--color-accent); }
.ui-switch:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-switch:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ui-switch__thumb {
  position: absolute;
  top: 50%;
  left: 1.5px;
  width: var(--space-4);
  height: var(--space-4);
  border-radius: var(--radius-full);
  background: var(--color-text-on-accent);
  box-shadow: var(--shadow-xs);
  transform: translateY(-50%);
  transition: left var(--duration-slow) var(--ease-in-out), width var(--duration-slow) var(--ease-in-out);
}
.ui-switch:not(:disabled):hover .ui-switch__thumb {
  width: calc(var(--space-4) * 1.125);
}
.ui-switch.is-on .ui-switch__thumb {
  left: calc(100% - var(--space-4) - 1.5px);
}
.ui-switch.is-on:not(:disabled):hover .ui-switch__thumb {
  left: calc(100% - var(--space-4) * 1.125 - 1.5px);
}
</style>
