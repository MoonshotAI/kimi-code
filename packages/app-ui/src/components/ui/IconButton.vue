<!-- apps/kimi-web/src/components/ui/IconButton.vue -->
<!-- Design-system §03 IconButton: sm 26 / md 32 (use md on touch for ≥32px target). -->
<script setup lang="ts">
import { ref } from 'vue';
import TooltipBubble from './TooltipBubble.vue';

withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  label?: string;
  /** Visible hover/focus tooltip, self-anchored to the button. Rendered inside
      the <button> so the component keeps its single-button root — parent
      scoped styles and app-region rules keep working unchanged. `label` only
      sets aria-label; pass both when the icon needs an on-screen hint (usually
      the same text). Do not combine with an outer Tooltip. */
  tooltip?: string;
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
       <button> via inheritAttrs, matching native button semantics.
       TooltipBubble renders nothing in place (body teleport), so the button
       stays the single root and contains only phrasing content. -->
  <button
    ref="el"
    class="ui-icon-button"
    :class="`ui-icon-button--${size}`"
    :type="type"
    :disabled="disabled"
    :aria-label="label"
  >
    <slot />
    <TooltipBubble v-if="tooltip" :target="el ?? null" :text="tooltip" />
  </button>
</template>

<style scoped>
.ui-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  border: 0.5px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
/* The translucent f1 wash, not a solid surface: stays visible on ANY
   backdrop — hover never darkens (the sunken token equals the page bg in
   dark mode, which made feedback vanish on --color-bg chrome). */
.ui-icon-button:hover:not(:disabled) { background: var(--color-hover); color: var(--color-text); }
.ui-icon-button:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ui-icon-button:disabled { opacity: 0.5; cursor: not-allowed; }

.ui-icon-button--sm { width: var(--icon-button-sm); height: var(--icon-button-sm); border-radius: var(--radius-sm); }
.ui-icon-button--md { width: 32px; height: 32px; }
.ui-icon-button--lg { width: 44px; height: 44px; }

.ui-icon-button :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ui-icon-button--sm :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ui-icon-button--lg :deep(svg) { width: var(--p-ic-lg); height: var(--p-ic-lg); }
</style>
