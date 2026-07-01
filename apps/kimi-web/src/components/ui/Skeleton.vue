<!-- apps/kimi-web/src/components/ui/Skeleton.vue -->
<!-- Design-system §03 Skeleton: breathing opacity placeholder (no gradient). -->
<script setup lang="ts">
defineProps<{ width?: string; height?: string; circle?: boolean }>();
</script>

<template>
  <span
    class="ui-skeleton"
    :class="{ 'is-circle': circle }"
    :style="{ width: width ?? '100%', height: height ?? '12px' }"
    aria-hidden="true"
  />
</template>

<style scoped>
.ui-skeleton {
  display: block;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  animation: ui-skeleton-breathe 1.2s var(--ease-in-out) infinite;
}
.ui-skeleton.is-circle { border-radius: var(--radius-full); }

@keyframes ui-skeleton-breathe {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-skeleton { animation: none; opacity: 0.6; }
}
</style>
