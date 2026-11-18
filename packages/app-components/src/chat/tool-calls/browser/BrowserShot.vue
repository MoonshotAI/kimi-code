<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { OpenMediaRequest, ToolMedia } from '@moonshot-ai/app-core/client/types';
import AuthMedia from '../../AuthMedia.vue';
import type { BrowserMark } from '../browserToolView';

const props = defineProps<{ media: ToolMedia; width: number; height: number; marks: BrowserMark[] }>();
const emit = defineEmits<{ openMedia: [payload: OpenMediaRequest] }>();
const { t } = useI18n();
const frame = ref<HTMLElement | null>(null);

const percent = (value: number, total: number) => `${Math.min(1, Math.max(0, value / total)) * 100}%`;

const boxes = computed(() => props.marks.flatMap((mark) => {
  if (mark.type !== 'box') return [];
  const left = Math.min(props.width, Math.max(0, mark.x));
  const top = Math.min(props.height, Math.max(0, mark.y));
  const right = Math.min(props.width, Math.max(0, mark.x + mark.width));
  const bottom = Math.min(props.height, Math.max(0, mark.y + mark.height));
  return [{
    tone: mark.tone,
    label: mark.label,
    labelInside: top / props.height < 0.08,
    style: { left: percent(left, props.width), top: percent(top, props.height), width: percent(right - left, props.width), height: percent(bottom - top, props.height) },
  }];
}));

const points = computed(() => props.marks.flatMap((mark) => mark.type === 'point'
  ? [{ left: percent(mark.x, props.width), top: percent(mark.y, props.height) }]
  : []));

const arrows = computed(() => props.marks.flatMap((mark) => {
  if (mark.type !== 'arrow') return [];
  const dx = mark.to.x - mark.from.x;
  const dy = mark.to.y - mark.from.y;
  let reach = 1;
  if (dx > 0) reach = Math.min(reach, (props.width - mark.from.x) / dx);
  if (dx < 0) reach = Math.min(reach, -mark.from.x / dx);
  if (dy > 0) reach = Math.min(reach, (props.height - mark.from.y) / dy);
  if (dy < 0) reach = Math.min(reach, -mark.from.y / dy);
  reach = Math.max(0, reach);
  const to = { x: mark.from.x + dx * reach, y: mark.from.y + dy * reach };
  return [{
    from: mark.from,
    to,
    start: { left: percent(mark.from.x, props.width), top: percent(mark.from.y, props.height) },
    head: { left: percent(to.x, props.width), top: percent(to.y, props.height), '--bshot-angle': `${Math.atan2(dy, dx)}rad` },
  }];
}));

function open(): void {
  emit('openMedia', { media: props.media, originImg: frame.value?.querySelector('img') ?? null });
}
</script>

<template>
  <button class="bshot" type="button" :aria-label="t('tools.browser.detail.openShot')" @click="open">
    <span ref="frame" class="bshot-frame" :style="{ '--bshot-ratio': `${width} / ${height}`, '--bshot-aspect': width / height }">
      <AuthMedia
        v-if="media.fileId"
        :url="media.url"
        kind="image"
        :file-id="media.fileId"
        :session-id="media.sessionId"
        media-class="bshot-img"
      />
      <img v-else class="bshot-img" :src="media.url" alt="" loading="lazy" />
      <span class="bshot-marks" aria-hidden="true">
        <svg v-if="arrows.length > 0" class="bshot-lines" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none">
          <template v-for="(arrow, index) in arrows" :key="index">
            <line class="bshot-line-halo" :x1="arrow.from.x" :y1="arrow.from.y" :x2="arrow.to.x" :y2="arrow.to.y" />
            <line class="bshot-line" :x1="arrow.from.x" :y1="arrow.from.y" :x2="arrow.to.x" :y2="arrow.to.y" />
          </template>
        </svg>
        <span v-for="(box, index) in boxes" :key="`box-${index}`" class="bshot-box" :class="box.tone" :style="box.style">
          <span v-if="box.label" class="bshot-label" :class="{ inside: box.labelInside }">{{ box.label }}</span>
        </span>
        <template v-for="(arrow, index) in arrows" :key="`arrow-${index}`">
          <span class="bshot-start" :style="arrow.start" />
          <span class="bshot-head" :style="arrow.head" />
        </template>
        <span v-for="(point, index) in points" :key="`point-${index}`" class="bshot-point" :style="point" />
      </span>
    </span>
  </button>
</template>

<style scoped>
.bshot {
  display: block;
  max-width: 100%;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: zoom-in;
}
.bshot:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.bshot-frame {
  position: relative;
  display: block;
  width: min(100%, calc(var(--browser-shot-max-height) * var(--bshot-aspect)));
  aspect-ratio: var(--bshot-ratio);
  border-radius: var(--radius-sm);
  background: var(--color-fill-2);
  overflow: hidden;
}
.bshot-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.bshot-marks,
.bshot-lines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.bshot-line,
.bshot-line-halo {
  fill: none;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.bshot-line {
  stroke: var(--browser-shot-mark-color);
  stroke-width: var(--browser-shot-mark-width);
}
.bshot-line-halo {
  stroke: var(--browser-shot-mark-halo-color);
  stroke-width: calc(var(--browser-shot-mark-width) + 2px);
}
.bshot-box {
  position: absolute;
  box-sizing: border-box;
  border: var(--browser-shot-mark-width) solid var(--browser-shot-mark-color);
  border-radius: var(--radius-xs);
  background: var(--browser-shot-mark-fill);
  box-shadow: var(--browser-shot-mark-halo);
}
.bshot-box.secondary {
  border-style: dashed;
  background: transparent;
}
.bshot-label {
  position: absolute;
  left: calc(var(--browser-shot-mark-width) * -1);
  bottom: 100%;
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs) var(--radius-xs) 0 0;
  background: var(--browser-shot-mark-color);
  color: var(--color-text-on-accent);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: var(--leading-normal);
  white-space: nowrap;
}
.bshot-label.inside {
  top: 0;
  bottom: auto;
  border-radius: 0 0 var(--radius-xs) 0;
}
.bshot-point,
.bshot-start {
  position: absolute;
  box-sizing: border-box;
  border-radius: var(--radius-full);
  transform: translate(-50%, -50%);
  box-shadow: var(--browser-shot-mark-halo);
}
.bshot-point {
  width: var(--browser-shot-point-size);
  height: var(--browser-shot-point-size);
  border: var(--browser-shot-mark-width) solid var(--browser-shot-mark-color);
  background: var(--browser-control-ring-fill);
}
.bshot-point::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 4px;
  height: 4px;
  margin: auto;
  border-radius: var(--radius-full);
  background: var(--browser-shot-mark-color);
}
.bshot-start {
  width: 8px;
  height: 8px;
  background: var(--browser-shot-mark-color);
}
.bshot-head {
  position: absolute;
  width: 0;
  height: 0;
  border-block: 6px solid transparent;
  border-left: 10px solid var(--browser-shot-mark-color);
  filter: drop-shadow(0 0 1px var(--browser-shot-mark-halo-color));
  transform: translate(-100%, -50%) rotate(var(--bshot-angle));
  transform-origin: 100% 50%;
}
</style>
