<script setup lang="ts">
import type { UseOverlayScrollbar } from '@moonshot-ai/app-client/composables';

defineProps<{
  scrollbar: Pick<
    UseOverlayScrollbar,
    'thumb' | 'thumbVisible' | 'onThumbPointerDown' | 'onThumbMouseEnter' | 'onThumbMouseLeave'
  >;
}>();
</script>

<template>
  <div
    v-if="scrollbar.thumb.value"
    class="model-scroll-thumb"
    :class="{ 'is-visible': scrollbar.thumbVisible.value }"
    :style="{ top: `${scrollbar.thumb.value.top}px`, height: `${scrollbar.thumb.value.height}px` }"
    aria-hidden="true"
    @pointerdown="scrollbar.onThumbPointerDown"
    @mouseenter="scrollbar.onThumbMouseEnter"
    @mouseleave="scrollbar.onThumbMouseLeave"
  />
</template>

<style scoped>
.model-scroll-thumb {
  position: absolute;
  right: var(--model-scroll-thumb-right, 6px);
  z-index: 3;
  width: 4px;
  border-radius: var(--radius-full);
  background: var(--color-menu-scrollbar);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out);
  touch-action: none;
}
.model-scroll-thumb.is-visible {
  opacity: 1;
  pointer-events: auto;
}
.model-scroll-thumb.is-visible:hover {
  background: var(--color-menu-scrollbar-hover);
}
.model-scroll-thumb::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -8px;
  right: -2px;
}
</style>
