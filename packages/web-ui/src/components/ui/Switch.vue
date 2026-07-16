<!-- apps/kimi-web/src/components/ui/Switch.vue -->
<!-- Design-system §03 Switch: 36×20 track, 16px thumb, instant-effect toggle. -->
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
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-full);
  background: var(--color-line-strong);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out);
}
.ui-switch.is-on { background: var(--color-accent); }
.ui-switch:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-switch:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ui-switch__thumb {
  position: absolute;
  top: 1.5px;
  left: 1.5px;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  background: var(--color-text-on-accent);
  box-shadow: var(--shadow-xs);
  transform-origin: left center;
  transition: transform var(--duration-base) var(--ease-out);
}
.ui-switch:not(:disabled):hover .ui-switch__thumb { transform: scaleX(1.125); }
.ui-switch.is-on .ui-switch__thumb {
  transform: translateX(16px);
  transform-origin: right center;
}
.ui-switch.is-on:not(:disabled):hover .ui-switch__thumb { transform: translateX(16px) scaleX(1.125); }
</style>
