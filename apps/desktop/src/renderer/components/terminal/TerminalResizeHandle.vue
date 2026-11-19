<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useResizable } from '@moonshot-ai/app-client/composables';
import { resizeHandleStep } from '../../lib/resizeSteps';

const props = withDefaults(
  defineProps<{
    storageKey: string;
    defaultHeight: number;
    min: number;
    max: number;
    ariaLabel?: string;
    applyLive?: (height: number) => void;
  }>(),
  {},
);

const emit = defineEmits<{
  'update:height': [height: number];
  'update:dragging': [dragging: boolean];
}>();

const { t } = useI18n();

const { width: height, dragging, cursor, setWidth, onPointerDown } = useResizable({
  storageKey: props.storageKey,
  defaultWidth: props.defaultHeight,
  min: props.min,
  max: () => props.max,
  axis: 'y',
  reverse: true,
  applyLive: props.applyLive,
});

emit('update:height', height.value);
watch(height, (h) => emit('update:height', h));
watch(dragging, (d) => emit('update:dragging', d));

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const step = (event.key === 'ArrowUp' ? 1 : -1) * resizeHandleStep(event.shiftKey);
  setWidth(height.value + step);
}
</script>

<template>
  <div
    class="trh"
    :class="{ dragging }"
    :style="{ cursor }"
    role="separator"
    aria-orientation="horizontal"
    :aria-label="ariaLabel ?? t('layout.resizeHandleAria')"
    :aria-valuenow="Math.round(height)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    @pointerdown="onPointerDown"
    @keydown="onKeydown"
  >
    <span class="trh-bar" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.trh {
  height: var(--space-1);
  flex: none;
  position: relative;
  background: transparent;
  touch-action: none;
  margin: calc(var(--space-05) * -1) 0;
  z-index: var(--z-dropdown);
}
.trh-bar {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: var(--space-05);
  translate: 0 -50%;
  background: transparent;
  transition: background var(--duration-fast) var(--ease-out);
}
.trh:hover .trh-bar {
  background: var(--color-selected);
}
.trh.dragging .trh-bar {
  background: var(--color-line-strong);
}
.trh:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
