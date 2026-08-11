<!-- apps/kimi-web/src/components/ui/AuthStateIcon.vue -->
<!-- Colored status illustrations for the login/auth flow (success / expired /
     error). One-off semantic graphics with brand colors, not line icons, so
     they live in one component instead of being inlined. -->
<script setup lang="ts">
defineProps<{ kind: 'success' | 'expired' | 'error' }>();
</script>

<template>
  <svg v-if="kind === 'success'" width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="var(--color-success)" stroke-width="2" aria-hidden="true">
    <circle cx="18" cy="18" r="15" />
    <polyline points="10,18 15,24 26,12" />
  </svg>
  <svg v-else-if="kind === 'expired'" width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--color-danger)" stroke-width="1.5" aria-hidden="true">
    <circle cx="14" cy="14" r="12" />
    <line x1="14" y1="8" x2="14" y2="15" />
    <circle cx="14" cy="19" r="1.2" fill="var(--color-danger)" />
  </svg>
  <svg v-else width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--color-warning)" stroke-width="1.5" aria-hidden="true">
    <path d="M14 3 L26 24 H2 Z" />
    <line x1="14" y1="12" x2="14" y2="18" />
    <circle cx="14" cy="21.5" r="1" fill="var(--color-warning)" />
  </svg>
</template>
