<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  pct: number;
  weight?: 'regular' | 'thin';
  indeterminate?: boolean;
  origin?: boolean;
}>(), {
  weight: 'regular',
  indeterminate: false,
  origin: false,
});

const GEOMETRY = {
  regular: { r: 7, stroke: 2.5 },
  thin: { r: 9.25, stroke: 1.5 },
} as const;

const INDETERMINATE_SPAN = 0.25;

const geometry = computed(() => GEOMETRY[props.weight]);
const circumference = computed(() => 2 * Math.PI * geometry.value.r);
const dashArray = computed(() => props.indeterminate
  ? `${circumference.value * INDETERMINATE_SPAN} ${circumference.value}`
  : `${circumference.value}`);
const dashOffset = computed(() => props.indeterminate
  ? 0
  : circumference.value * (1 - Math.min(100, Math.max(0, props.pct)) / 100));
</script>

<template>
  <svg
    class="ctx-ring"
    :class="[`ctx-ring--${weight}`, { 'ctx-ring--indeterminate': indeterminate }]"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <circle class="ctx-ring-track" cx="10" cy="10" :r="geometry.r" fill="none" :stroke-width="geometry.stroke" />
    <circle
      class="ctx-ring-fill"
      cx="10"
      cy="10"
      :r="geometry.r"
      fill="none"
      :stroke-width="geometry.stroke"
      stroke-linecap="round"
      :stroke-dasharray="dashArray"
      :stroke-dashoffset="`${dashOffset}`"
    />
    <circle v-if="origin" class="ctx-ring-origin" :cx="10 + geometry.r" cy="10" :r="geometry.stroke / 2" />
  </svg>
</template>

<style scoped>
.ctx-ring {
  width: 16px;
  height: 16px;
  flex: none;
  transform: rotate(-90deg);
}
.ctx-ring-track {
  stroke: var(--line);
}
.ctx-ring-fill {
  stroke: var(--color-accent);
  transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;
}
.ctx-ring-origin {
  fill: var(--color-accent);
}
.ctx-ring--indeterminate .ctx-ring-fill {
  transform-box: view-box;
  transform-origin: center;
  transition: stroke 0.3s ease;
  animation: ctx-ring-spin var(--duration-flash) linear infinite;
}
@keyframes ctx-ring-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .ctx-ring--indeterminate .ctx-ring-fill {
    animation: none;
  }
}
</style>
