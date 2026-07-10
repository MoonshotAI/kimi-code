<!-- apps/kimi-web/src/components/ui/Menu.vue -->
<!-- Design-system §03 Menu: raised dropdown panel. Positioning is left to the
     consumer; this provides the surface + item layout. -->
<script setup lang="ts">
import { ref } from 'vue';

// Expose the panel element so call sites can anchor / outside-click against the
// menu surface (positioning is intentionally left to the consumer).
const el = ref<HTMLElement>();
defineExpose({ el });
</script>

<template>
  <div ref="el" class="ui-menu" role="menu">
    <slot />
  </div>
</template>

<style scoped>
.ui-menu {
  min-width: 180px;
  padding: var(--space-1);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
}
</style>
