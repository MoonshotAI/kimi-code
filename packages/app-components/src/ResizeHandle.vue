<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useResizable } from '@moonshot-ai/app-client/composables';
import { resizeHandleStep } from './lib/resizeSteps';

const props = withDefaults(
  defineProps<{
    storageKey: string;
    defaultWidth: number;
    min: number;
    max: number;
    reverse?: boolean;
    ariaLabel?: string;
    applyLive?: (width: number) => void;
  }>(),
  {},
);

const emit = defineEmits<{
  'update:width': [width: number];
  'update:dragging': [dragging: boolean];
}>();

const { t } = useI18n();

const { width, dragging, cursor, setWidth, onPointerDown } = useResizable({
  storageKey: props.storageKey,
  defaultWidth: props.defaultWidth,
  min: props.min,
  max: () => props.max,
  reverse: () => props.reverse,
  applyLive: props.applyLive,
});

emit('update:width', width.value);
watch(width, (w) => emit('update:width', w));
watch(dragging, (d) => emit('update:dragging', d));

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const dir = event.key === 'ArrowRight' ? 1 : -1;
  const sign = props.reverse ? -dir : dir;
  setWidth(width.value + sign * resizeHandleStep(event.shiftKey));
}
</script>

<template>
  <div
    class="rh"
    :class="{ dragging }"
    :style="{ cursor }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="ariaLabel ?? t('layout.resizeHandleAria')"
    :aria-valuenow="Math.round(width)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    @pointerdown="onPointerDown"
    @keydown="onKeydown"
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
  margin: 0 -2px;
  z-index: var(--z-dropdown);
}
.rh-bar {
  position: absolute;
  inset: 0 1px;
  background: transparent;
  transition: background 0.12s;
}
.rh:hover .rh-bar {
  background: var(--color-selected);
}
.rh.dragging .rh-bar {
  background: var(--color-line-strong);
}
.rh:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
