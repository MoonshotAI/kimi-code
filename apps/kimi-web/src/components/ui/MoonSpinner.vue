<!-- apps/kimi-web/src/components/ui/MoonSpinner.vue -->
<!-- Design-system §03 MoonSpinner: the SOLE sanctioned emoji-as-icon. Use ONLY
     for "message sent, waiting for Agent's first response". All other loading
     states must use Spinner. Pauses on the current frame under reduced motion. -->
<script setup lang="ts">
const MOON_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_FRAME_MS = 120;
const MOON_FAST_FRAME_MS = 60;

withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg';
  fast?: boolean;
  label?: string;
}>(), {
  size: 'md',
  label: 'Waiting for response…',
});

function moonFrameStyle(index: number): Record<string, string> {
  return {
    '--moon-frame-delay': `${index * MOON_FRAME_MS}ms`,
    '--moon-frame-fast-delay': `${index * MOON_FAST_FRAME_MS}ms`,
  };
}
</script>

<template>
  <span
    class="ui-moon"
    :class="[`ui-moon--${size}`, { 'ui-moon--fast': fast }]"
    :aria-label="label"
    role="img"
  >
    <span
      v-for="(frame, index) in MOON_FRAMES"
      :key="frame"
      class="ui-moon__frame"
      :style="moonFrameStyle(index)"
      aria-hidden="true"
    >
      {{ frame }}
    </span>
  </span>
</template>

<style scoped>
.ui-moon {
  display: inline-block;
  position: relative;
  line-height: 1;
  user-select: none;
  flex: none;
}
.ui-moon--sm { width: 14px; height: 14px; font-size: 14px; }
.ui-moon--md { width: 18px; height: 18px; font-size: 18px; }
.ui-moon--lg { width: 24px; height: 24px; font-size: 24px; }

.ui-moon__frame {
  position: absolute;
  inset: 0;
  display: block;
  text-align: center;
  opacity: 0;
  animation-name: ui-moon-frame;
  animation-duration: 960ms;
  animation-timing-function: steps(1, end);
  animation-iteration-count: infinite;
  animation-delay: var(--moon-frame-delay);
}
.ui-moon--fast .ui-moon__frame {
  animation-duration: 480ms;
  animation-delay: var(--moon-frame-fast-delay);
}

@keyframes ui-moon-frame {
  0%, 12.49% { opacity: 1; }
  12.5%, 100% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-moon__frame { animation: none; opacity: 0; }
  .ui-moon__frame:nth-child(4) { opacity: 1; }
}
</style>
