<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';

withDefaults(defineProps<{
  size?: 'xs' | 'sm' | 'md' | 'lg';
  label?: string;
}>(), {
  size: 'md',
});

const { t } = useKimiI18n();

const boxRef = ref<HTMLElement | null>(null);
let spin: Animation | undefined;
let reduceMotion: MediaQueryList | undefined;

function syncMotion(): void {
  const el = boxRef.value;
  if (!el) return;
  if (reduceMotion?.matches) {
    spin?.cancel();
    spin = undefined;
    return;
  }
  if (spin) return;
  const duration = parseFloat(getComputedStyle(el).getPropertyValue('--duration-spin'));
  spin = el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 700,
    iterations: Infinity,
  });
  spin.startTime = 0;
}

onMounted(() => {
  const el = boxRef.value;
  if (!el || typeof el.animate !== 'function') return;
  reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduceMotion.addEventListener('change', syncMotion);
  syncMotion();
});

onBeforeUnmount(() => {
  reduceMotion?.removeEventListener('change', syncMotion);
  reduceMotion = undefined;
  spin?.cancel();
  spin = undefined;
});
</script>

<template>
  <span ref="boxRef" class="ui-spinner" :class="`ui-spinner--${size}`" role="status" :aria-label="label ?? t('common.loading')">
    <svg class="ui-spinner__svg" viewBox="0 0 24 24" aria-hidden="true">
      <circle class="ui-spinner__track" cx="12" cy="12" r="9" />
      <circle class="ui-spinner__arc" cx="12" cy="12" r="9" />
    </svg>
  </span>
</template>

<style scoped>
.ui-spinner { display: inline-flex; flex: none; color: var(--color-accent); }
.ui-spinner--xs { width: var(--p-ic-md); height: var(--p-ic-md); }
.ui-spinner--xs .ui-spinner__track,
.ui-spinner--xs .ui-spinner__arc {
  r: 10.875px;
  stroke-width: calc(var(--p-ring-stroke) * 1.5);
}
.ui-spinner--xs .ui-spinner__arc {
  stroke-dasharray: 67.7 67.7;
  stroke-dashoffset: 45.9;
}
.ui-spinner--sm { width: 14px; height: 14px; }
.ui-spinner--md { width: 18px; height: 18px; }
.ui-spinner--lg { width: 28px; height: 28px; }

.ui-spinner__svg { width: 100%; height: 100%; }
.ui-spinner__track { fill: none; stroke: var(--color-line); stroke-width: 2.2; }
.ui-spinner__arc {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-dasharray: 56 56;
  stroke-dashoffset: 38;
}
</style>
