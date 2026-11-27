<script setup lang="ts">
import { ref } from 'vue';
import TooltipBubble from './TooltipBubble.vue';

withDefaults(defineProps<{
  size?: 'xs' | 'sm' | 'md' | 'lg';
  tone?: 'default' | 'danger';
  disabled?: boolean;
  pressed?: boolean;
  label?: string;
  tooltip?: string;
  tooltipArrow?: boolean;
  keys?: string[];
  type?: 'button' | 'submit' | 'reset';
}>(), {
  size: 'md',
  tone: 'default',
  type: 'button',
  pressed: undefined,
  keys: () => [],
});

const el = ref<HTMLButtonElement>();
defineExpose({ el });
</script>

<template>
  <button
    ref="el"
    class="ui-icon-button"
    :class="[`ui-icon-button--${size}`, { 'ui-icon-button--danger': tone === 'danger', 'is-pressed': pressed }]"
    :aria-pressed="pressed"
    :type="type"
    :disabled="disabled"
    :aria-label="label"
  >
    <slot />
    <TooltipBubble v-if="tooltip" :target="el ?? null" :text="tooltip" :keys="keys" :arrow="tooltipArrow" />
  </button>
</template>

<style scoped>
.ui-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  border: var(--p-hairline) solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.ui-icon-button:hover:not(:disabled) { background: var(--color-hover); color: var(--color-text); }
.ui-icon-button--danger:hover:not(:disabled) { background: var(--color-danger-soft); color: var(--color-danger); }
.ui-icon-button.is-pressed { background: var(--color-selected); color: var(--color-text); }
.ui-icon-button.is-pressed:hover:not(:disabled) { background: var(--color-selected-hover); }
.ui-icon-button:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ui-icon-button:disabled { opacity: 0.5; cursor: not-allowed; }

.ui-icon-button--xs { width: var(--icon-button-xs); height: var(--icon-button-xs); border-radius: var(--radius-xs); }
.ui-icon-button--sm { width: var(--icon-button-sm); height: var(--icon-button-sm); border-radius: var(--radius-sm); }
.ui-icon-button--md { width: 32px; height: 32px; }
.ui-icon-button--lg { width: 44px; height: 44px; }

.ui-icon-button :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ui-icon-button--xs :deep(svg) { width: var(--p-ic-sm); height: var(--p-ic-sm); }
.ui-icon-button--sm :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ui-icon-button--lg :deep(svg) { width: var(--p-ic-lg); height: var(--p-ic-lg); }
</style>
