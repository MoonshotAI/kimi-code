<!-- apps/kimi-web/src/components/ui/IconButton.vue -->
<!-- Design-system §03 IconButton: sm 26 / md 32 (use md on touch for ≥32px target). -->
<script setup lang="ts">
import { ref } from 'vue';

withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  label?: string;
  type?: 'button' | 'submit' | 'reset';
}>(), {
  size: 'md',
  type: 'button',
});

// Expose the underlying <button> for call sites that need the DOM node
// (e.g. positioning a floating menu against the button via getBoundingClientRect).
const el = ref<HTMLButtonElement>();
defineExpose({ el });
</script>

<template>
  <!-- Native click (and modifiers like .stop) fall through to the inner
       <button> via inheritAttrs, matching native button semantics. -->
  <button
    ref="el"
    class="ui-icon-button"
    :class="`ui-icon-button--${size}`"
    :type="type"
    :disabled="disabled"
    :aria-label="label"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
/* Translucent text-mix instead of the sunken surface: stays visible on ANY
   backdrop — the sunken token equals the page bg in dark mode, which made
   hover feedback vanish for icon buttons sitting directly on --color-bg
   (chat header, flat sidebar). */
.ui-icon-button:hover:not(:disabled) { background: color-mix(in srgb, var(--color-text) 8%, transparent); color: var(--color-text); }
.ui-icon-button:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ui-icon-button:disabled { opacity: 0.5; cursor: not-allowed; }

.ui-icon-button--sm { width: 26px; height: 26px; border-radius: var(--radius-sm); }
.ui-icon-button--md { width: 32px; height: 32px; }
.ui-icon-button--lg { width: 44px; height: 44px; }

.ui-icon-button :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ui-icon-button--sm :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ui-icon-button--lg :deep(svg) { width: var(--p-ic-lg); height: var(--p-ic-lg); }
</style>
