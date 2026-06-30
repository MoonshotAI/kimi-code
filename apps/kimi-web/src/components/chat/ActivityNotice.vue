<!-- apps/kimi-web/src/components/chat/ActivityNotice.vue -->
<!-- Generic in-transcript "working on X" notice: a moon-phase spinner plus a
     body-sized label. Used for long-running session activities that are not a
     chat turn (e.g. "Compacting context…"). The moon is rendered by the single
     sanctioned MoonSpinner primitive (design-system §03/§06). -->
<script setup lang="ts">
import MoonSpinner from '../ui/MoonSpinner.vue';

defineProps<{
  label: string;
}>();
</script>

<template>
  <div class="activity-notice" role="status">
    <span aria-hidden="true"><MoonSpinner size="sm" /></span>
    <span class="an-label">{{ label }}</span>
  </div>
</template>

<style scoped>
/* Smaller than body text (text-sm) so the notice reads as lightweight
   in-transcript chrome rather than a full turn. */
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
