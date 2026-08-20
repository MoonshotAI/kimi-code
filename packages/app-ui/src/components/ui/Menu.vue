<!-- apps/kimi-web/src/components/ui/Menu.vue -->
<!-- Design-system §03 Menu: raised dropdown panel. Positioning is left to the
     consumer; this provides the surface + item layout. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { registerMenuSurface } from '../../composables/menuStack';

// `menu` for action lists (the default); `dialog` for popovers whose content
// isn't menuitems (search inputs, grids — e.g. SessionEmojiPicker).
withDefaults(defineProps<{ role?: 'menu' | 'dialog' }>(), { role: 'menu' });

// Expose the panel element so call sites can anchor / outside-click against the
// menu surface (positioning is intentionally left to the consumer).
const el = ref<HTMLElement>();
defineExpose({ el });

// Menus render with v-if only while open, so mounted == open: register the
// surface so TooltipBubble suppresses tooltips outside it (native behavior).
let releaseSurface: (() => void) | undefined;
onMounted(() => {
  if (el.value) releaseSurface = registerMenuSurface(el.value);
});
onBeforeUnmount(() => releaseSurface?.());
</script>

<template>
  <div ref="el" class="ui-menu" :role="role">
    <slot />
  </div>
</template>

<style scoped>
.ui-menu {
  min-width: 180px;
  padding: var(--menu-pad);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  display: flex;
  flex-direction: column;
}
</style>
