<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { browserViewportResizeRequest, resizedBrowserViewport } from '../../lib/browserViewportResize';
import { useI18n } from 'vue-i18n';
import type { BrowserDeviceState, BrowserDeviceModeRequest } from '../../../shared/browser-device';
const props = defineProps<{ device: BrowserDeviceState; resize: (request: BrowserDeviceModeRequest) => Promise<void> }>();
const { t } = useI18n();
const root = ref<HTMLElement>();
const available = ref({ width: 0, height: 0 });
const dragging = ref(false);
let observer: ResizeObserver | undefined;
let pending: BrowserDeviceModeRequest | undefined;
let running = false;
let disposed = false;
let gesture: { x: number; y: number; width: number; height: number; scale: number; axis: string; target: HTMLElement; pointerId: number } | undefined;
const frameStyle = computed(() => {
  const width = Math.min(available.value.width, Math.round(props.device.width * props.device.displayScale));
  const height = Math.min(available.value.height, Math.round(props.device.height * props.device.displayScale));
  return { left: `${Math.max(0, Math.floor((available.value.width - width) / 2))}px`, top: `${Math.max(0, Math.floor((available.value.height - height) / 2))}px`, width: `${width}px`, height: `${height}px` };
});
async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try { while (pending && !disposed) { const request = pending; pending = undefined; await props.resize(request); } }
  catch { pending = undefined; }
  finally { running = false; }
}
function update(width: number, height: number): void {
  pending = browserViewportResizeRequest(props.device, width, height);
  void drain();
}
function start(event: PointerEvent, axis: string): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const target = event.currentTarget as HTMLElement;
  target.focus();
  target.setPointerCapture(event.pointerId);
  gesture = { x: event.clientX, y: event.clientY, width: props.device.width, height: props.device.height, scale: props.device.displayScale, axis, target, pointerId: event.pointerId };
  dragging.value = true;
}
function move(event: PointerEvent): void {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const size = resizedBrowserViewport(gesture, { x: event.clientX - gesture.x, y: event.clientY - gesture.y }, gesture.axis, available.value);
  update(size.width, size.height);
}
function stop(): void {
  const previous = gesture;
  gesture = undefined;
  dragging.value = false;
  if (previous?.target.hasPointerCapture(previous.pointerId)) previous.target.releasePointerCapture(previous.pointerId);
}
function keydown(event: KeyboardEvent, axis: string): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 10 : 1;
  const dx = axis === 'height' ? 0 : event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = axis === 'width' ? 0 : event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
  update(props.device.width + dx, props.device.height + dy);
}
onMounted(() => {
  observer = new ResizeObserver(() => { if (root.value) available.value = { width: root.value.clientWidth, height: root.value.clientHeight }; });
  if (root.value) observer.observe(root.value);
});
onUnmounted(() => { disposed = true; pending = undefined; stop(); observer?.disconnect(); });
</script>
<template>
  <div ref="root" class="resize-area" :class="{ dragging }">
    <div class="resize-frame" :style="frameStyle">
      <button v-for="axis in ['width', 'height', 'both']" :key="axis" type="button" class="resize-handle" :class="`resize-${axis}`" :aria-label="t(`browser.device.resize${axis}`)" :title="t(`browser.device.resize${axis}`)" @pointerdown="start($event, axis)" @pointermove="move" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop" @keydown="keydown($event, axis)"><span /></button>
    </div>
  </div>
</template>
<style scoped>
.resize-area { position: absolute; inset: var(--space-6); pointer-events: none; }
.resize-frame { position: absolute; }
.resize-handle { position: absolute; display: grid; place-items: center; padding: 0; border: 0; background: transparent; color: var(--color-text-muted); pointer-events: auto; touch-action: none; -webkit-app-region: no-drag; }
.resize-handle:hover, .dragging .resize-handle { color: var(--color-text); }
.resize-handle:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.resize-width { left: 100%; top: 0; width: var(--space-6); height: 100%; cursor: ew-resize; }
.resize-height { top: 100%; left: 0; height: var(--space-6); width: 100%; cursor: ns-resize; }
.resize-both { left: 100%; top: 100%; width: var(--space-6); height: var(--space-6); cursor: nwse-resize; }
.resize-handle span { display: grid; place-items: center; background: var(--color-surface-raised); border: var(--p-hairline) solid var(--color-line-strong); border-radius: var(--radius-sm); box-shadow: var(--shadow-xs); }
.resize-handle:hover span, .dragging .resize-handle span { background: var(--color-hover); border-color: var(--color-text-muted); }
.resize-width span { height: var(--space-10); width: var(--space-4); }
.resize-height span { width: var(--space-10); height: var(--space-4); }
.resize-both span { width: var(--space-5); height: var(--space-5); }
.resize-handle span::after { content: ''; }
.resize-width span::after { height: var(--space-4); width: var(--space-1); border-inline: var(--p-hairline) solid currentColor; }
.resize-height span::after { width: var(--space-4); height: var(--space-1); border-block: var(--p-hairline) solid currentColor; }
.resize-both span::after { width: var(--space-2); height: var(--space-2); border-right: var(--p-hairline) solid currentColor; border-bottom: var(--p-hairline) solid currentColor; }
</style>
