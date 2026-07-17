<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from 'vue';

type Axis = 'vertical' | 'horizontal';
type Orientation = Axis | 'both';

const props = withDefaults(defineProps<{
  orientation?: Orientation;
  hideDelay?: number;
}>(), {
  orientation: 'vertical',
  hideDelay: 600,
});

interface ScrollMetric {
  overflow: boolean;
  size: number;
  offset: number;
}

interface DragState {
  axis: Axis;
  pointerId: number;
  startPointer: number;
  startScroll: number;
}

const root = ref<HTMLElement | null>(null);
const viewport = ref<HTMLElement | null>(null);
const visible = ref(false);
const vertical = ref<ScrollMetric>({ overflow: false, size: 0, offset: 0 });
const horizontal = ref<ScrollMetric>({ overflow: false, size: 0, offset: 0 });
const drag = ref<DragState | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;

const viewportStyle = computed<CSSProperties>(() => ({
  overflowX: props.orientation === 'vertical' ? 'hidden' : 'auto',
  overflowY: props.orientation === 'horizontal' ? 'hidden' : 'auto',
}));
const verticalThumbStyle = computed(() => ({
  height: `${vertical.value.size}px`,
  transform: `translateY(${vertical.value.offset}px)`,
}));
const horizontalThumbStyle = computed(() => ({
  width: `${horizontal.value.size}px`,
  transform: `translateX(${horizontal.value.offset}px)`,
}));

function metric(viewportSize: number, contentSize: number, scrollOffset: number): ScrollMetric {
  const overflow = contentSize > viewportSize + 1;
  if (!overflow || viewportSize <= 0) return { overflow: false, size: 0, offset: 0 };
  const trackSize = Math.max(0, viewportSize - 4);
  const size = Math.min(trackSize, Math.max(24, trackSize * viewportSize / contentSize));
  const maxOffset = Math.max(0, trackSize - size);
  const maxScroll = Math.max(1, contentSize - viewportSize);
  return { overflow: true, size, offset: maxOffset * scrollOffset / maxScroll };
}

function updateMetrics(): void {
  const el = viewport.value;
  if (!el) return;
  const v = metric(el.clientHeight, el.scrollHeight, el.scrollTop);
  const h = metric(el.clientWidth, el.scrollWidth, el.scrollLeft);
  // Only write the refs when a value actually changed. Assigning a fresh
  // object every time re-renders the component on each observer callback;
  // with mutating slot content (e.g. an entering TransitionGroup) that
  // re-render itself mutates the observed subtree, re-firing the
  // MutationObserver and looping the renderer at 100% CPU.
  if (v.overflow !== vertical.value.overflow || v.size !== vertical.value.size || v.offset !== vertical.value.offset) {
    vertical.value = v;
  }
  if (h.overflow !== horizontal.value.overflow || h.size !== horizontal.value.size || h.offset !== horizontal.value.offset) {
    horizontal.value = h;
  }
}

function cancelHide(): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = null;
}

function showScrollbar(): void {
  cancelHide();
  visible.value = true;
}

function scheduleHide(): void {
  cancelHide();
  if (drag.value || root.value?.matches(':hover, :focus-within')) return;
  hideTimer = setTimeout(() => {
    visible.value = false;
    hideTimer = null;
  }, props.hideDelay);
}

function onScroll(): void {
  updateMetrics();
  showScrollbar();
  scheduleHide();
}

function startDrag(axis: Axis, event: PointerEvent): void {
  const el = viewport.value;
  if (!el) return;
  event.preventDefault();
  showScrollbar();
  drag.value = {
    axis,
    pointerId: event.pointerId,
    startPointer: axis === 'vertical' ? event.clientY : event.clientX,
    startScroll: axis === 'vertical' ? el.scrollTop : el.scrollLeft,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveDrag(event: PointerEvent): void {
  const active = drag.value;
  const el = viewport.value;
  if (!active || active.pointerId !== event.pointerId || !el) return;
  const currentPointer = active.axis === 'vertical' ? event.clientY : event.clientX;
  const viewportSize = active.axis === 'vertical' ? el.clientHeight : el.clientWidth;
  const contentSize = active.axis === 'vertical' ? el.scrollHeight : el.scrollWidth;
  const thumbSize = active.axis === 'vertical' ? vertical.value.size : horizontal.value.size;
  const availableTrack = Math.max(1, viewportSize - 4 - thumbSize);
  const scrollDelta = (currentPointer - active.startPointer) * (contentSize - viewportSize) / availableTrack;
  if (active.axis === 'vertical') el.scrollTop = active.startScroll + scrollDelta;
  else el.scrollLeft = active.startScroll + scrollDelta;
}

function finishDrag(event: PointerEvent): void {
  if (!drag.value || drag.value.pointerId !== event.pointerId) return;
  drag.value = null;
  scheduleHide();
}

function observeContent(): void {
  const el = viewport.value;
  if (!el || !resizeObserver) return;
  for (const child of el.children) resizeObserver.observe(child);
}

onMounted(async () => {
  await nextTick();
  const el = viewport.value;
  if (!el) return;
  resizeObserver = new ResizeObserver(updateMetrics);
  resizeObserver.observe(el);
  observeContent();
  mutationObserver = new MutationObserver(() => {
    observeContent();
    updateMetrics();
  });
  mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });
  updateMetrics();
});

onBeforeUnmount(() => {
  cancelHide();
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
});

defineExpose({ viewport, updateMetrics });
</script>

<template>
  <div
    ref="root"
    class="ui-scroll-area"
    @pointerenter="showScrollbar"
    @pointerleave="scheduleHide"
    @focusin="showScrollbar"
    @focusout="scheduleHide"
  >
    <div
      ref="viewport"
      class="ui-scroll-area__viewport"
      :style="viewportStyle"
      tabindex="0"
      @scroll="onScroll"
    >
      <slot />
    </div>
    <div
      v-if="vertical.overflow && props.orientation !== 'horizontal'"
      class="ui-scroll-area__bar ui-scroll-area__bar--vertical"
      :class="{ 'is-visible': visible }"
      aria-hidden="true"
    >
      <span
        class="ui-scroll-area__thumb"
        :style="verticalThumbStyle"
        @pointerdown="startDrag('vertical', $event)"
        @pointermove="moveDrag"
        @pointerup="finishDrag"
        @pointercancel="finishDrag"
      />
    </div>
    <div
      v-if="horizontal.overflow && props.orientation !== 'vertical'"
      class="ui-scroll-area__bar ui-scroll-area__bar--horizontal"
      :class="{ 'is-visible': visible }"
      aria-hidden="true"
    >
      <span
        class="ui-scroll-area__thumb"
        :style="horizontalThumbStyle"
        @pointerdown="startDrag('horizontal', $event)"
        @pointermove="moveDrag"
        @pointerup="finishDrag"
        @pointercancel="finishDrag"
      />
    </div>
  </div>
</template>

<style scoped>
.ui-scroll-area {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.ui-scroll-area__viewport {
  width: 100%;
  height: 100%;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.ui-scroll-area__viewport::-webkit-scrollbar { display: none; }
.ui-scroll-area__viewport:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.ui-scroll-area__bar {
  position: absolute;
  z-index: 3;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  transition: opacity var(--duration-base) var(--ease-out);
}
.ui-scroll-area__bar.is-visible {
  opacity: 1;
  pointer-events: auto;
}
.ui-scroll-area__bar--vertical {
  inset: 2px 2px 2px auto;
  width: 10px;
}
.ui-scroll-area__bar--horizontal {
  inset: auto 2px 2px 2px;
  height: 10px;
}
.ui-scroll-area__thumb {
  position: absolute;
  display: block;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted) 62%, transparent);
  transition: background var(--duration-fast) var(--ease-out),
    width var(--duration-fast) var(--ease-out),
    height var(--duration-fast) var(--ease-out);
}
.ui-scroll-area__bar--vertical .ui-scroll-area__thumb {
  right: 1px;
  width: 4px;
}
.ui-scroll-area__bar--horizontal .ui-scroll-area__thumb {
  bottom: 1px;
  height: 4px;
}
.ui-scroll-area__bar:hover .ui-scroll-area__thumb,
.ui-scroll-area__thumb:active {
  background: color-mix(in srgb, var(--color-text-muted) 82%, transparent);
}
.ui-scroll-area__bar--vertical:hover .ui-scroll-area__thumb,
.ui-scroll-area__bar--vertical .ui-scroll-area__thumb:active { width: 6px; }
.ui-scroll-area__bar--horizontal:hover .ui-scroll-area__thumb,
.ui-scroll-area__bar--horizontal .ui-scroll-area__thumb:active { height: 6px; }
</style>
