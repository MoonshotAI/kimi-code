<script setup lang="ts">
import { Spinner } from '@moonshot-ai/app-ui';

defineProps<{
  label: string;
}>();
</script>

<template>
  <div class="activity-notice" role="status">
    <span aria-hidden="true"><Spinner size="sm" /></span>
    <span class="an-label">{{ label }}</span>
  </div>
</template>

<style scoped>
.activity-notice {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  align-self: flex-start;
  margin: 0;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-muted);
}
</style>
