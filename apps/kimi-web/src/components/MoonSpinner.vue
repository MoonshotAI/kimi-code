<!-- apps/kimi-web/src/components/MoonSpinner.vue -->
<!-- CSS-only moon phase spinner used while waiting for a response. -->
<script setup lang="ts">
const MOON_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_FRAME_MS = 120;
const MOON_FAST_FRAME_MS = 60;

withDefaults(defineProps<{
  fast?: boolean;
  label?: string;
}>(), {
  label: 'Working…',
});

function moonFrameStyle(index: number): Record<string, string> {
  return {
    '--moon-frame-delay': `${index * MOON_FRAME_MS}ms`,
    '--moon-frame-fast-delay': `${index * MOON_FAST_FRAME_MS}ms`,
  };
}
</script>

<template>
  <span class="moon-spin" :class="{ 'moon-spin--fast': fast }" :aria-label="label" role="img">
    <span
      v-for="(frame, index) in MOON_FRAMES"
      :key="frame"
      class="moon-frame"
      :style="moonFrameStyle(index)"
      aria-hidden="true"
    >
      {{ frame }}
    </span>
  </span>
</template>

<style scoped>
.moon-spin {
  --moon-frame: 1.15em;
  display: inline-block;
  position: relative;
  width: var(--moon-frame);
  height: var(--moon-frame);
  font-size: var(--ui-font-size);
  line-height: 1;
  user-select: none;
  vertical-align: -0.1em;
}

.moon-frame {
  position: absolute;
  inset: 0;
  display: block;
  text-align: center;
  opacity: 0;
  animation-name: moon-frame;
  animation-duration: 960ms;
  animation-timing-function: steps(1, end);
  animation-iteration-count: infinite;
  animation-delay: var(--moon-frame-delay);
}

.moon-spin--fast .moon-frame {
  animation-duration: 480ms;
  animation-delay: var(--moon-frame-fast-delay);
}

@keyframes moon-frame {
  0%,
  12.49% { opacity: 1; }
  12.5%,
  100% { opacity: 0; }
}
</style>
