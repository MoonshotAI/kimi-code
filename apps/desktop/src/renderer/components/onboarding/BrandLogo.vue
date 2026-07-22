<!-- apps/web/src/components/onboarding/BrandLogo.vue -->
<!-- Kimi Code app icon for the onboarding wizard, inlined so the mascot's
     eyes hook the shared idle look/blink keyframes in style.css (the same
     .ch-eyes/.ch-eye classes the sidebar logo uses); a click plays one quick
     blink via .blink-now — the sidebar mark's easter egg, minus its
     long-press. The black/white tile swaps by data-color-scheme (two <rect>s,
     no CSS colors); the face gradient id is per-instance so coexisting logos
     (wizard + login card) can't collide. -->
<script setup lang="ts">
import { onBeforeUnmount, ref, useId } from 'vue';

withDefaults(defineProps<{ size?: number }>(), { size: 64 });

const faceId = `bl-face-${useId()}`;

// Click-to-blink easter egg (same mechanism as the sidebar logo): force a
// reflow so rapid clicks restart the one-shot, then drop the class so the
// idle loop resumes.
const logoRef = ref<SVGSVGElement | null>(null);
let blinkTimer: ReturnType<typeof setTimeout> | undefined;
function blinkOnce(): void {
  const el = logoRef.value;
  if (!el) return;
  el.classList.remove('blink-now');
  void el.getBoundingClientRect();
  el.classList.add('blink-now');
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => el.classList.remove('blink-now'), 300);
}
onBeforeUnmount(() => clearTimeout(blinkTimer));
</script>

<template>
  <svg
    ref="logoRef"
    class="brand-logo"
    :style="{ width: `${size}px`, height: `${size}px` }"
    viewBox="0 0 120 120"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Kimi Code"
    @click="blinkOnce"
  >
    <defs>
      <radialGradient :id="faceId" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(60.2763 54.8061) scale(40.1164)">
        <stop stop-color="#117DFB" />
        <stop offset="0.759254" stop-color="#449BFF" />
        <stop offset="1" stop-color="#77B6FF" />
      </radialGradient>
    </defs>
    <rect class="bl-tile bl-tile-light" width="120" height="120" rx="20" fill="black" />
    <rect class="bl-tile bl-tile-dark" width="120" height="120" rx="20" fill="white" />
    <path d="M60.2763 20C82.1633 20 99.9061 37.7429 99.9061 59.6298C99.9061 81.5168 82.1633 99.2597 60.2763 99.2597C38.3894 99.2597 20.6465 81.5168 20.6465 59.6298C20.6465 37.7429 38.3894 20 60.2763 20Z" fill="#2389FF" />
    <path d="M60.2763 20C82.1633 20 99.9061 37.7429 99.9061 59.6298C99.9061 81.5168 82.1633 99.2597 60.2763 99.2597C38.3894 99.2597 20.6465 81.5168 20.6465 59.6298C20.6465 37.7429 38.3894 20 60.2763 20Z" :fill="`url(#${faceId})`" />
    <g class="ch-eyes" fill="#fff">
      <path class="ch-eye" d="M55.4475 44.1022C55.0677 41.3366 56.9839 38.7892 59.7275 38.4124C62.4711 38.0356 65.0032 39.972 65.383 42.7376L66.5397 51.1594C66.9195 53.925 65.0033 56.4724 62.2597 56.8492C59.5161 57.2261 56.984 55.2896 56.6042 52.524L55.4475 44.1022Z" />
      <path class="ch-eye" d="M76.2959 41.4461C75.9351 38.8188 77.6443 36.414 80.1136 36.0749C82.5828 35.7358 84.877 37.5907 85.2379 40.218L86.3367 48.2187C86.6976 50.846 84.9884 53.2508 82.5191 53.5899C80.0499 53.9291 77.7556 52.0741 77.3948 49.4468L76.2959 41.4461Z" />
    </g>
    <rect x="19.0006" y="69.7068" width="82.296" height="29.6266" rx="3.29184" fill="#002E58" />
    <path d="M26.2428 78.8867L34.5753 83.6974C35.2611 84.0934 35.2611 85.0832 34.5753 85.4792L26.2428 90.2899" stroke="white" stroke-width="2.82158" stroke-linecap="round" />
    <path d="M40.726 90.4453H48.9556" stroke="#007CFF" stroke-width="3.29184" stroke-linecap="round" />
    <path d="M97.1815 20C99.454 20 101.296 21.8423 101.296 24.1148C101.296 26.3873 99.454 28.2296 97.1815 28.2296L93.5508 28.2296C93.2834 28.2296 93.0667 28.0129 93.0667 27.7455V24.1148C93.0667 21.8423 94.9089 20 97.1815 20Z" fill="#1783FF" />
  </svg>
</template>

<style scoped>
.brand-logo {
  display: block;
  flex: none;
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  /* Lift the tile off near-black dark surfaces (and vice versa). */
  border: 1px solid var(--color-line);
  border-radius: 16.67%; /* matches the tile's own rx=20/120 */
  box-sizing: border-box;
}
/* Tile swap by theme — the two <rect>s carry their own fill, so this block
   stays token-clean (same selectors the token layer uses). */
.bl-tile-dark { display: none; }
html[data-color-scheme="dark"] .bl-tile-light { display: none; }
html[data-color-scheme="dark"] .bl-tile-dark { display: block; }
@media (prefers-color-scheme: dark) {
  html[data-color-scheme="system"] .bl-tile-light { display: none; }
  html[data-color-scheme="system"] .bl-tile-dark { display: block; }
}
</style>
