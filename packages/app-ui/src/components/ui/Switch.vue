<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue: boolean;
    disabled?: boolean;
    label?: string;
    size?: 'md' | 'lg';
    decorative?: boolean;
  }>(),
  { size: 'md' },
);

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <span
    v-if="decorative"
    class="ui-switch"
    :class="[`ui-switch--${size}`, { 'is-on': modelValue }]"
    aria-hidden="true"
  >
    <span class="ui-switch__thumb" />
  </span>
  <button
    v-else
    class="ui-switch"
    :class="[`ui-switch--${size}`, { 'is-on': modelValue }]"
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
  --ui-switch-thumb: var(--space-4);
  --ui-switch-inset: 1.5px;
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex: none;
  padding: 0;
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-full);
  background: var(--color-line-strong);
  transition: background var(--duration-slow) var(--ease-in-out);
}
.ui-switch--lg {
  --ui-switch-thumb: var(--space-5);
  --ui-switch-inset: 2.5px;
  width: 44px;
  height: 26px;
}
button.ui-switch { cursor: pointer; }
.ui-switch.is-on { background: var(--color-accent); }
button.ui-switch:disabled { opacity: 0.5; cursor: not-allowed; }
button.ui-switch:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ui-switch__thumb {
  position: absolute;
  top: 50%;
  left: var(--ui-switch-inset);
  width: var(--ui-switch-thumb);
  height: var(--ui-switch-thumb);
  border-radius: var(--radius-full);
  background: var(--color-text-on-accent);
  box-shadow: var(--shadow-xs);
  transform: translateY(-50%);
  transition: left var(--duration-slow) var(--ease-in-out), width var(--duration-slow) var(--ease-in-out);
}
button.ui-switch:not(:disabled):hover .ui-switch__thumb {
  width: calc(var(--ui-switch-thumb) * 1.125);
}
.ui-switch.is-on .ui-switch__thumb {
  left: calc(100% - var(--ui-switch-thumb) - var(--ui-switch-inset));
}
button.ui-switch.is-on:not(:disabled):hover .ui-switch__thumb {
  left: calc(100% - var(--ui-switch-thumb) * 1.125 - var(--ui-switch-inset));
}
</style>
