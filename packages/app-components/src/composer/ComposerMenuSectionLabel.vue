<script setup lang="ts">
defineProps<{ afterSection?: boolean }>();
</script>

<template>
  <div class="composer-menu-section-label" :class="{ 'after-section': afterSection }" role="presentation"><slot /></div>
</template>

<style scoped>
.composer-menu-section-label {
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: var(--space-1) var(--space-2) var(--space-05);
  color: var(--color-text-muted);
  font: var(--weight-semibold) var(--text-xs) / var(--leading-tight) var(--font-ui);
}
.composer-menu-section-label.after-section {
  margin-top: var(--space-2);
}
</style>
