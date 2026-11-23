<script setup lang="ts">
import { computed, ref } from 'vue';
import { StatusDot, Tooltip } from '@moonshot-ai/app-ui';
import type { OpenMediaRequest } from '@moonshot-ai/app-core/client/types';
import { useBrowserReceipt } from '../browserReceipts';

const props = defineProps<{ sessionId: string; receiptId: string; variant: 'row' | 'frame'; label: string; live?: boolean }>();
const emit = defineEmits<{ openMedia: [payload: OpenMediaRequest] }>();
const root = ref<HTMLElement | null>(null);
const { state, receipt } = useBrowserReceipt(() => ({ sessionId: props.sessionId, receiptId: props.receiptId }), root);

const RATIO_MIN = 0.6;
const RATIO_MAX = 2.4;

const percent = (value: number) => `${Math.round(value * 10000) / 100}%`;
const round = (value: number) => Math.round(value * 10000) / 10000;

const anchor = computed(() => {
  const current = receipt.value;
  if (current?.box) return { x: current.box.x + current.box.width / 2, y: current.box.y + current.box.height / 2 };
  return current?.point ?? { x: 0.5, y: 0.5 };
});

const zoom = computed(() => {
  const current = receipt.value;
  if (current?.box) return Math.round(Math.min(3, Math.max(1, 0.8 / Math.max(current.box.width, current.box.height))) * 100) / 100;
  return current?.point ? 2 : 1;
});

const shape = computed(() => {
  const current = receipt.value;
  if (!current) return undefined;
  const actual = current.width / current.height;
  const shown = Math.min(RATIO_MAX, Math.max(RATIO_MIN, actual));
  const across = Math.min(1, actual / shown);
  const down = Math.min(1, shown / actual);
  const height = props.variant === 'row' ? '--browser-receipt-thumb-height' : '--browser-receipt-frame-height';
  return {
    frame: { width: `calc(var(${height}) * ${round(shown)})` },
    canvas: {
      left: percent((1 - across) / 2),
      top: percent((1 - down) / 2),
      width: percent(across),
      height: percent(down),
      ...(props.variant === 'row' ? { transformOrigin: `${percent(anchor.value.x)} ${percent(anchor.value.y)}`, transform: `scale(${zoom.value})` } : {}),
    },
  };
});

function open(event: MouseEvent): void {
  const current = receipt.value;
  if (!current) return;
  emit('openMedia', {
    media: { kind: 'image', url: current.url, mimeType: 'image/jpeg' },
    originImg: (event.currentTarget as HTMLElement).querySelector('img'),
  });
}
</script>

<template>
  <span v-if="state === 'idle' || state === 'loading'" ref="root" class="brt brt-pending" :class="`brt-${variant}`" aria-hidden="true" />
  <Tooltip v-else-if="state === 'ready' && receipt && shape" :text="label">
    <button type="button" class="brt" :class="`brt-${variant}`" :style="shape.frame" :aria-label="label" @click.stop="open">
      <span class="brt-canvas" :style="shape.canvas">
        <img class="brt-img" :src="receipt.url" alt="" />
        <span
          v-if="variant === 'row' && receipt.point"
          class="brt-dot"
          :style="{ left: percent(receipt.point.x), top: percent(receipt.point.y), transform: `translate(-50%, -50%) scale(${round(1 / zoom)})` }"
          aria-hidden="true"
        />
        <template v-if="variant === 'frame'">
          <span
            v-if="receipt.box"
            class="brt-box"
            :style="{ left: percent(receipt.box.x), top: percent(receipt.box.y), width: percent(receipt.box.width), height: percent(receipt.box.height) }"
            aria-hidden="true"
          />
          <span v-if="receipt.point" class="brt-ring" :style="{ left: percent(receipt.point.x), top: percent(receipt.point.y) }" aria-hidden="true" />
        </template>
      </span>
      <span v-if="live" class="brt-live" aria-hidden="true"><StatusDot status="running" /></span>
    </button>
  </Tooltip>
  <span v-else-if="state === 'missing' && variant === 'frame'" class="brt brt-frame brt-missing" aria-hidden="true" />
</template>

<style scoped>
.brt {
  position: relative;
  display: block;
  flex: none;
  padding: 0;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xs);
  background: var(--color-fill-2);
  overflow: hidden;
}
button.brt {
  cursor: zoom-in;
}
button.brt:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.brt-row {
  width: var(--browser-receipt-thumb-width);
  height: var(--browser-receipt-thumb-height);
}
.brt-frame {
  width: var(--browser-receipt-frame-width);
  height: var(--browser-receipt-frame-height);
  border-radius: var(--radius-sm);
}
.brt-canvas {
  position: absolute;
  display: block;
}
.brt-img {
  display: block;
  width: 100%;
  height: 100%;
}
.brt-dot,
.brt-ring {
  position: absolute;
  box-sizing: border-box;
  border-radius: var(--radius-full);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.brt-dot {
  width: 6px;
  height: 6px;
  background: var(--browser-shot-mark-color);
  box-shadow: 0 0 0 1px var(--browser-shot-mark-halo-color);
}
.brt-ring {
  width: 12px;
  height: 12px;
  border: var(--browser-shot-mark-width) solid var(--browser-shot-mark-color);
  background: var(--browser-shot-mark-fill);
  box-shadow: var(--browser-shot-mark-halo);
}
.brt-box {
  position: absolute;
  box-sizing: border-box;
  border: var(--browser-shot-mark-width) solid var(--browser-shot-mark-color);
  border-radius: var(--radius-xs);
  box-shadow: var(--browser-shot-mark-halo);
  pointer-events: none;
}
.brt-missing {
  background: var(--color-surface-sunken);
}
.brt-live {
  position: absolute;
  top: var(--space-05);
  right: var(--space-05);
  display: flex;
  border-radius: var(--radius-full);
  box-shadow: 0 0 0 var(--browser-live-dot-halo) var(--color-surface-raised);
}
</style>
