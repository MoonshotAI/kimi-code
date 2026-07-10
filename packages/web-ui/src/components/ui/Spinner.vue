<!-- apps/kimi-web/src/components/ui/Spinner.vue -->
<!-- Design-system §03 Spinner: the DEFAULT loader (SVG ring). Use everywhere
     except the chat "waiting for Agent response" state, which uses MoonSpinner. -->
<script setup lang="ts">
withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}>(), {
  size: 'md',
  label: 'Loading',
});
</script>

<template>
  <span class="ui-spinner" :class="`ui-spinner--${size}`" role="status" :aria-label="label">
    <svg class="ui-spinner__svg" viewBox="0 0 24 24" aria-hidden="true">
      <circle class="ui-spinner__track" cx="12" cy="12" r="9" />
      <circle class="ui-spinner__arc" cx="12" cy="12" r="9" />
    </svg>
  </span>
</template>

<style scoped>
.ui-spinner { display: inline-flex; flex: none; color: var(--color-accent); }
.ui-spinner--sm { width: 14px; height: 14px; }
.ui-spinner--md { width: 18px; height: 18px; }
.ui-spinner--lg { width: 28px; height: 28px; }

.ui-spinner__svg { width: 100%; height: 100%; animation: ui-spinner-rotate 0.85s linear infinite; }
.ui-spinner__track { fill: none; stroke: var(--color-line); stroke-width: 2.2; }
.ui-spinner__arc {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-dasharray: 56 56;
  stroke-dashoffset: 38;
}

@keyframes ui-spinner-rotate {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .ui-spinner__svg { animation-duration: 1.8s; }
}
</style>
