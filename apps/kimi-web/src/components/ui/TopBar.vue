<!-- apps/kimi-web/src/components/ui/TopBar.vue -->
<!-- Design-system §03 TopBar: solid by default; the `frost` variant is the SOLE
     glassmorphism exception (backdrop-filter) and only for sticky nav bars. -->
<script setup lang="ts">
defineProps<{ frost?: boolean }>();
</script>

<template>
  <header class="ui-topbar" :class="{ 'ui-topbar--frost': frost }">
    <span class="ui-topbar__title"><slot /></span>
    <span class="ui-topbar__actions"><slot name="actions" /></span>
  </header>
</template>

<style scoped>
.ui-topbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: 48px;
  padding: 0 var(--space-4);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
}
.ui-topbar--frost {
  background: color-mix(in srgb, var(--color-surface) 78%, transparent);
  -webkit-backdrop-filter: saturate(150%) blur(12px);
  backdrop-filter: saturate(150%) blur(12px);
}
.ui-topbar__title { flex: 1; font-weight: var(--weight-medium); font-size: var(--text-sm); color: var(--color-text); min-width: 0; }
.ui-topbar__actions { display: inline-flex; align-items: center; gap: var(--space-1); }
</style>
