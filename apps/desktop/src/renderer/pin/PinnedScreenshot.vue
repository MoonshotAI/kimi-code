<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon, IconButton } from '@moonshot-ai/app-ui';
import type { PinBridge } from '../screenshot/types';
import { pinResizeEdgeAt, type PinResizeEdge } from '../../shared/screenshot-pin';

const params = new URLSearchParams(location.search);
const source = computed(() => params.get('src') ?? '');
const imageDescription = params.get('locale') === 'zh' ? '已贴图的截图' : 'Pinned screenshot';
const closeLabel = params.get('locale') === 'zh' ? '关闭' : 'Close';
const bridge = window.pinBridge as PinBridge | undefined;
let drag: { pointerId: number; x: number; y: number; edge: PinResizeEdge | null } | null = null;
const resizeEdge = ref<PinResizeEdge | null>(null);
const cursor = computed(() => {
  if (resizeEdge.value === null) return 'move';
  if (resizeEdge.value === 'top' || resizeEdge.value === 'bottom') return 'ns-resize';
  if (resizeEdge.value === 'left' || resizeEdge.value === 'right') return 'ew-resize';
  return resizeEdge.value === 'top-left' || resizeEdge.value === 'bottom-right' ? 'nwse-resize' : 'nesw-resize';
});
let moved = false;

function edgeAt(event: PointerEvent): PinResizeEdge | null {
  if (bridge?.platform !== 'win32') return null;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return pinResizeEdgeAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  moved = false;
  drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, edge: edgeAt(event) };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  resizeEdge.value = drag?.edge ?? edgeAt(event);
  if (drag === null || drag.pointerId !== event.pointerId) return;
  const deltaX = event.screenX - drag.x;
  const deltaY = event.screenY - drag.y;
  if (!moved && Math.hypot(deltaX, deltaY) < 3) return;
  moved = true;
  drag.x = event.screenX;
  drag.y = event.screenY;
  if (drag.edge === null) bridge?.move(deltaX, deltaY);
  else bridge?.resizeFromEdge(drag.edge, deltaX, deltaY);
}

function endDrag(): void {
  drag = null;
}

function onDoubleClick(event: MouseEvent): void {
  if (event.button === 0 && !moved) bridge?.close();
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  bridge?.resize(event.deltaY < 0 ? 0.1 : -0.1);
}
</script>

<template>
  <main
    class="pin"
    :style="{ cursor }"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @lostpointercapture="endDrag"
    @dblclick="onDoubleClick"
  >
    <img :src="source" :alt="imageDescription" crossorigin="anonymous" draggable="false" @load="bridge?.ready()" @error="bridge?.failed()" />
    <div class="pin__close" @pointerdown.stop @dblclick.stop @wheel.stop>
      <IconButton :label="closeLabel" :tooltip="closeLabel" @click.stop="bridge?.close()">
        <Icon name="close" />
      </IconButton>
    </div>
  </main>
</template>

<style scoped>
.pin {
  position: relative;
  width: 100%;
  height: 100%;
  touch-action: none;
  user-select: none;
}

.pin img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.pin__close {
  position: absolute;
  display: flex;
  top: var(--space-1);
  right: var(--space-1);
  background: var(--color-surface-overlay);
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: var(--radius-md);
  opacity: 0;
  pointer-events: none;
}

.pin:hover .pin__close,
.pin:focus-within .pin__close {
  opacity: 1;
  pointer-events: auto;
}

@media (hover: none) {
  .pin__close {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
