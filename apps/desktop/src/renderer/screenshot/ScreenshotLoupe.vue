<script setup lang="ts">
import { Button } from '@moonshot-ai/app-ui';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { LOUPE_PANEL_SIZE, LOUPE_PIXELS, LOUPE_SIZE, loupePosition, loupeScale, rgbHex, rgbaColor, sourcePixel } from './loupe';
import { createLoupeTile, readLoupeTile, type LoupeTile } from './loupe-pixels';
import type { Point, ScreenshotOverlayContext } from './types';

const props = defineProps<{
  context: ScreenshotOverlayContext;
  frame: HTMLImageElement;
  pointer: Point;
  allowFormatToggle?: boolean;
}>();

const STRINGS = {
  zh: { info: '像素信息', position: '坐标', copy: '复制颜色', copied: '已复制颜色', copyHint: '按 C 复制颜色值', switchHint: '按 Shift 切换 RGBA/HEX' },
  en: { info: 'Pixel information', position: 'Position', copy: 'Copy color', copied: 'Color copied', copyHint: 'Press C to copy', switchHint: 'Shift for RGBA/HEX' },
} as const;

const canvasRef = ref<HTMLCanvasElement | null>(null);
const sample = ref<Uint8ClampedArray | null>(null);
const format = ref<'hex' | 'rgba'>('hex');
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
let shiftArmed = false;
const bridge = window.shotBridge;
const s = computed(() => STRINGS[props.context.locale]);
const pixel = computed(() => sourcePixel(props.pointer, props.context));
const hex = computed(() => sample.value === null ? '' : rgbHex(sample.value));
const colorText = computed(() => sample.value === null ? '' : format.value === 'hex' ? rgbHex(sample.value) : rgbaColor(sample.value));
const displayColor = computed(() => format.value === 'rgba' ? colorText.value.slice(5, -1) : colorText.value);
const position = ref(loupePosition(props.pointer, props.context.displaySize));
const pinned = ref(false);
const style = computed(() => ({
  width: `${LOUPE_PANEL_SIZE.width}px`,
  height: `${LOUPE_PANEL_SIZE.height}px`,
  transform: `translate(${position.value.x}px, ${position.value.y}px) scale(${loupeScale(props.context.displaySize)})`,
}));
let tile: LoupeTile | null = null;

function releaseTile(): void {
  if (tile === null) return;
  tile.canvas.width = 1;
  tile.canvas.height = 1;
  tile = null;
}

function ensureTile(): LoupeTile | null {
  if (tile !== null) return tile;
  try {
    tile = createLoupeTile();
    return tile;
  } catch {
    return null;
  }
}

function nearPanel(point: Point, margin: number): boolean {
  const scale = loupeScale(props.context.displaySize);
  const current = position.value;
  return point.x >= current.x - margin
    && point.x <= current.x + LOUPE_PANEL_SIZE.width * scale + margin
    && point.y >= current.y - margin
    && point.y <= current.y + LOUPE_PANEL_SIZE.height * scale + margin;
}

function render(): void {
  copied.value = false;
  const canvas = canvasRef.value;
  if (canvas === null) return;
  const context = canvas.getContext('2d');
  if (context === null) return;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  context.fillStyle = '#171717';
  context.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  const currentTile = ensureTile();
  if (currentTile === null) {
    sample.value = null;
    return;
  }
  try {
    sample.value = readLoupeTile(props.frame, pixel.value, currentTile);
    context.drawImage(currentTile.canvas, 0, 0, LOUPE_PIXELS, LOUPE_PIXELS, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
  } catch {
    sample.value = null;
  }
}

function toggleFormat(): void {
  format.value = format.value === 'hex' ? 'rgba' : 'hex';
}

async function copyColor(): Promise<void> {
  const captureId = props.context.captureId;
  const value = colorText.value;
  if (value === '' || bridge === undefined) return;
  try {
    if (!await bridge.copyColor(captureId, value)) return;
    if (props.context.captureId !== captureId || colorText.value !== value) return;
    copied.value = true;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1200);
  } catch {
    copied.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.repeat) return;
  if (event.key === 'Shift') {
    shiftArmed = !event.metaKey && !event.ctrlKey && !event.altKey && props.allowFormatToggle !== false;
    return;
  }
  shiftArmed = false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'c') return;
  event.preventDefault();
  void copyColor();
}

function onKeyup(event: KeyboardEvent): void {
  if (event.key !== 'Shift') return;
  if (shiftArmed && props.allowFormatToggle !== false) toggleFormat();
  shiftArmed = false;
}

watch(() => props.pointer, (current) => {
  if (pinned.value) {
    if (!nearPanel(current, 24)) {
      pinned.value = false;
      position.value = loupePosition(current, props.context.displaySize);
    }
  } else if (nearPanel(current, 12)) {
    pinned.value = true;
  } else {
    position.value = loupePosition(current, props.context.displaySize);
  }
}, { flush: 'sync' });
watch(() => [props.context.captureId, props.frame], () => {
  releaseTile();
  pinned.value = false;
  position.value = loupePosition(props.pointer, props.context.displaySize);
}, { flush: 'sync' });
watch(() => [props.context.captureId, props.frame, props.pointer], () => render(), { flush: 'post' });
watch(() => props.allowFormatToggle, (allowed) => {
  if (allowed === false) shiftArmed = false;
});
watch(colorText, () => { copied.value = false; });

onMounted(() => {
  render();
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('keyup', onKeyup, true);
});

onBeforeUnmount(() => {
  releaseTile();
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('keyup', onKeyup, true);
  if (copiedTimer !== null) clearTimeout(copiedTimer);
});
</script>

<template>
  <aside
    class="shot__loupe"
    :style="style"
    :aria-label="s.info"
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @contextmenu.stop.prevent
  >
    <div class="shot__loupe-image" :style="{ width: `${LOUPE_SIZE}px`, height: `${LOUPE_SIZE}px` }">
      <canvas ref="canvasRef" :width="LOUPE_SIZE" :height="LOUPE_SIZE" aria-hidden="true" />
      <span class="shot__loupe-guide shot__loupe-guide--vertical" aria-hidden="true" />
      <span class="shot__loupe-guide shot__loupe-guide--horizontal" aria-hidden="true" />
      <span class="shot__loupe-marker" aria-hidden="true" />
    </div>
    <div class="shot__loupe-details">
      <div class="shot__loupe-coordinates">{{ s.position }}: {{ pixel.x }},{{ pixel.y }}</div>
      <div class="shot__loupe-color">
        <span class="shot__loupe-swatch" :style="{ backgroundColor: hex || 'transparent' }" aria-hidden="true" />
        <Button
          class="shot__loupe-value"
          :class="{ 'is-rgba': format === 'rgba' }"
          variant="text"
          size="xs"
          :disabled="colorText === ''"
          :aria-label="copied ? s.copied : s.copy"
          @click="copyColor"
        >{{ format.toUpperCase() }}:{{ displayColor || '—' }}</Button>
      </div>
      <div class="shot__loupe-hint">{{ copied ? s.copied : s.copyHint }}</div>
      <div class="shot__loupe-hint">{{ s.switchHint }}</div>
    </div>
  </aside>
</template>

<style scoped>
.shot__loupe { position: absolute; z-index: 10; top: 0; left: 0; width: 136px; height: 216px; overflow: hidden; transform-origin: top left; will-change: transform; background: var(--color-term-black); box-shadow: 0 0 0 1px var(--color-scrim-strong), var(--shadow-menu); color: var(--color-text-on-scrim); }
.shot__loupe-image { position: relative; overflow: hidden; background: var(--color-term-black); }
.shot__loupe-image canvas { display: block; image-rendering: pixelated; }
.shot__loupe-guide { position: absolute; background: color-mix(in srgb, var(--color-accent) 52%, var(--color-text-on-scrim)); pointer-events: none; }
.shot__loupe-guide--vertical { top: 0; bottom: 0; left: calc(50% - 2px); width: 4px; }
.shot__loupe-guide--horizontal { right: 0; left: 0; top: calc(50% - 2px); height: 4px; }
.shot__loupe-marker { position: absolute; top: calc(50% - 4px); left: calc(50% - 4px); width: 8px; height: 8px; border: 1px solid var(--color-term-black); background: var(--color-text-on-scrim); box-shadow: 0 0 0 1px var(--color-text-on-scrim); pointer-events: none; }
.shot__loupe-details { display: grid; grid-template-rows: 16px 16px 13px 13px; gap: var(--space-05); height: 80px; padding: var(--space-2) var(--space-1-5); background: var(--color-term-black); }
.shot__loupe-coordinates { overflow: hidden; color: var(--color-text-on-scrim); font-size: var(--text-xs); font-weight: var(--weight-medium); line-height: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.shot__loupe-color { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.shot__loupe-swatch { flex: 0 0 auto; width: 12px; height: 12px; border: 1px solid var(--color-text-on-scrim); background: transparent; }
.shot__loupe-value { min-width: 0; overflow: hidden; color: var(--color-text-on-scrim); font-size: var(--text-xs); font-weight: var(--weight-medium); line-height: 16px; font-variant-numeric: tabular-nums; text-align: left; text-decoration: none; white-space: nowrap; cursor: copy; }
.shot__loupe-value:not(:disabled):hover { color: var(--color-text-on-scrim); }
.shot__loupe-value.is-rgba { font-size: var(--ui-c2); letter-spacing: -0.2px; }
.shot__loupe-value:disabled { cursor: default; }
.shot__loupe-hint { overflow: hidden; color: var(--color-text-on-scrim); font-size: var(--ui-c2); font-weight: var(--weight-regular); line-height: 13px; white-space: nowrap; }
</style>
