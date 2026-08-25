<!-- Trailing chat status: the 小蓝 mascot plus a phase label — "Requesting…"
     while the submit is in flight, "Working…" once the main turn is live.
     Replaces the MoonSpinner sending placeholder. -->
<script setup lang="ts">
import { KimiMascot } from '@moonshot-ai/app-components';

defineProps<{
  label: string;
}>();
</script>

<template>
  <div class="working-indicator" role="status">
    <span class="wi-mascot" aria-hidden="true"><KimiMascot /></span>
    <span class="wi-label">{{ label }}</span>
  </div>
</template>

<style scoped>
.working-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  align-self: flex-start;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-muted);
}
/* The artboard pads the blob (~60/72 of the canvas), so the host is sized a
   touch larger than the text line it sits next to. */
.wi-mascot {
  flex: none;
  width: 40px;
}
/* The label breathes like the streaming "Thinking…" title (opacity only —
   the design system bans gradient shimmer text). */
.wi-label {
  animation: wi-breathe 1.6s var(--ease-in-out) infinite;
}
@keyframes wi-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
</style>
