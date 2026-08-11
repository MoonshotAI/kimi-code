<!-- apps/web/src/components/ResizeHandle.vue -->
<!-- A thin (~4px) vertical drag bar used to resize the panel to its LEFT. It -->
<!-- owns the width via useResizable and reports changes through v-model:width so -->
<!-- the parent can drive its grid/flex sizing. Directional resize cursor (at a -->
<!-- drag limit it hints the one direction that still works), a 2px indicator bar -->
<!-- that shows the neutral fills one step up the ramp (f2 hover, f3 drag — never accent),
<!-- no text-selection while dragging. -->
<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useResizable } from '@moonshot-ai/app-client/composables';

const props = withDefaults(
  defineProps<{
    storageKey: string;
    defaultWidth: number;
    min: number;
    max: number;
    reverse?: boolean;
    ariaLabel?: string;
    /** Optional live applier: while dragging, each frame calls it with the
        clamped width INSTEAD of emitting update:width (which then fires once
        on pointerup). Lets the parent write straight to the DOM and skip a
        Vue re-render per frame. */
    applyLive?: (width: number) => void;
  }>(),
  {},
);

const emit = defineEmits<{
  'update:width': [width: number];
  /** True while dragging — parents disable width transitions so the panel
      tracks the pointer without animation lag. */
  'update:dragging': [dragging: boolean];
}>();

const { t } = useI18n();

const { width, dragging, cursor, onPointerDown } = useResizable({
  storageKey: props.storageKey,
  defaultWidth: props.defaultWidth,
  min: props.min,
  // Pass a getter so the cap stays reactive: a viewport-derived max can grow
  // after the handle mounts and the next drag will use the new limit.
  max: () => props.max,
  reverse: props.reverse,
  applyLive: props.applyLive,
});

// Surface the restored width immediately, then keep the parent in sync on drag.
emit('update:width', width.value);
watch(width, (w) => emit('update:width', w));
watch(dragging, (d) => emit('update:dragging', d));
</script>

<template>
  <div
    class="rh"
    :class="{ dragging }"
    :style="{ cursor }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="ariaLabel ?? t('layout.resizeHandleAria')"
    @pointerdown="onPointerDown"
  >
    <span class="rh-bar" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.rh {
  width: 4px;
  flex: none;
  position: relative;
  align-self: stretch;
  background: transparent;
  touch-action: none;
  /* sits over the 1px column border so the whole 4px strip is grabbable */
  margin: 0 -2px;
  /* above pane-level sticky chrome (chat dock, headers at --z-sticky): its 2px
     overhang into the neighbour pane must stay visible and grabbable */
  z-index: var(--z-dropdown);
}
.rh-bar {
  position: absolute;
  /* 2px indicator line centred in the 4px grab strip (the strip stays 4px
     so the hit target doesn't shrink). */
  inset: 0 1px;
  background: transparent;
  transition: background 0.12s;
}
/* Neutral fills, never accent: f2 on hover, one step stronger (f3) while
   the drag is live — the same ramp as row hover/selected, shifted one step
   up so the 2px line stays visible on the translucent sidebar material. */
.rh:hover .rh-bar {
  background: var(--color-selected);
}
.rh.dragging .rh-bar {
  background: var(--color-line-strong);
}
</style>
