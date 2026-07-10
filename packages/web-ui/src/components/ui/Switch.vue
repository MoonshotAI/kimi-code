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
  border: none;
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
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  background: var(--color-text-on-accent);
  box-shadow: var(--shadow-xs);
  transition: transform var(--duration-base) var(--ease-out);
}
.ui-switch.is-on .ui-switch__thumb { transform: translateX(16px); }
</style>
