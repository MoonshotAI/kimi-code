<!-- Generic in-transcript "working on X" notice: a plain spinner plus a
     body-sized label. Used for long-running session activities that are not a
     chat turn (e.g. "Compacting context…"). Uses the plain Spinner primitive
     (design-system §03/§06) — WorkingIndicator is reserved for the chat
     working state after a prompt is sent. -->
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
