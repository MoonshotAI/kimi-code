<!-- apps/kimi-web/src/components/ui/Spinner.vue -->
<!-- Design-system §03 Spinner: the DEFAULT loader (SVG ring). Use everywhere
     except the chat working state, which uses WorkingIndicator. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';

withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}>(), {
  size: 'md',
});

const { t } = useKimiI18n();

// Phase-lock every Spinner to the document timeline: each instance's animation
// is anchored to the same absolute start time (the timeline's zero), so
// spinners that mount at different moments (e.g. several busy sessions in the
// sidebar) sweep in perfect sync. This uses WAAPI instead of a CSS animation:
// mutating a running CSS animation's delay restarts it in Blink (a visible
// jump plus up-to-a-frame phase jitter), and reading its duration via
// getComputedStyle forces a synchronous style flush on every mount.
// The animation targets the HTML wrapper, NOT the <svg>: Blink can't composite
// transforms on SVG elements, so animating the svg would run on the main
// thread (re-rasterizing vector content every frame). On the HTML wrapper the
// rotation is composited — the svg is rasterized once into a layer and the
// compositor spins it for free.
const boxRef = ref<HTMLElement | null>(null);
let spin: Animation | undefined;
let reduceMotion: MediaQueryList | undefined;

// Start or stop the rotation to match the reduced-motion setting. The apps'
// global reduced-motion rule (`animation-duration: 0.001ms !important` in each
// app's style.css) can't reach WAAPI animations, so mirror it here: no
// rotation while prefers-reduced-motion matches, and follow live changes of
// the setting just like the media query did.
function syncMotion(): void {
  const el = boxRef.value;
  if (!el) return;
  if (reduceMotion?.matches) {
    spin?.cancel();
    spin = undefined;
    return;
  }
  if (spin) return;
  // Design-system tempo: 0.85s per turn.
  spin = el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
    duration: 850,
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
