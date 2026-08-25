<!-- Rive "K I [retro computer] M I" doodle — the same interactive asset as
     the kimi.com homepage banner (see assets/doodle/k3_doodle1.riv; artboard
     338×152, state machine "doodle", one custom 'light/dark' input synced
     with the app theme). The runtime+wasm (~2.3MB) are lazy dynamic imports
     kept out of the entry chunk; until they arrive — or permanently when
     they fail to load, or under reduced motion — the `fallback` slot shows
     in their place. Once playing, lib/rivePlayback pauses the instance
     whenever the page is hidden or the canvas scrolls out of the viewport,
     so the runtime's per-frame render loop stops instead of holding the
     screen's refresh rate. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useIsDark } from '@moonshot-ai/app-core';
import rivUrl from './assets/doodle/k3_doodle1.riv?url';
import { bindRivePlayback } from '@moonshot-ai/app-core/lib';

const ready = ref(false);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isDark = useIsDark();
let teardown: (() => void) | null = null;
let unbindPlayback: (() => void) | null = null;

onMounted(async () => {
  // Reduced motion: don't even fetch the runtime, keep the fallback.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    const [{ Rive, RuntimeLoader }, wasmUrl, wasmFallbackUrl] = await Promise.all([
      import('@rive-app/canvas'),
      import('@rive-app/canvas/rive.wasm?url').then((m) => m.default),
      import('@rive-app/canvas/rive_fallback.wasm?url').then((m) => m.default),
    ]);
    const canvas = canvasRef.value;
    if (!canvas) return; // Unmounted while the runtime was loading.
    // Both URLs must be local — the defaults pull from jsdelivr/unpkg, which
    // is unreachable offline (the fallback build serves non-SIMD browsers).
    RuntimeLoader.setWasmUrl(wasmUrl);
    RuntimeLoader.setWasmFallbackUrl(wasmFallbackUrl);

    const rive = new Rive({
      canvas,
      src: rivUrl,
      autoplay: true,
      onLoad() {
        const sm = rive.stateMachineNames[0];
        if (sm) rive.play(sm);
        // stateMachineInputs() returns undefined during the synchronous
        // onLoad callback — defer a frame before touching inputs/resizing.
        requestAnimationFrame(() => {
          if (!canvasRef.value) return;
          applyTheme();
          rive.resizeDrawingSurfaceToCanvas(); // bitmap = CSS size × DPR
          // Gate the frame loop on page visibility + viewport intersection
          // (bound only now, once the instance is loaded and playing).
          unbindPlayback = bindRivePlayback(rive, canvas);
          ready.value = true;
        });
      },
    });

    function applyTheme(): void {
      const sm = rive.stateMachineNames[0];
      if (!sm) return;
      const input = (rive.stateMachineInputs(sm) ?? []).find((i) => i.name === 'light/dark');
      if (input) input.value = isDark.value ? 1 : 0;
    }

    const stopThemeWatch = watch(isDark, applyTheme);
    const onResize = () => rive.resizeDrawingSurfaceToCanvas();
    window.addEventListener('resize', onResize);
    teardown = () => {
      unbindPlayback?.();
      unbindPlayback = null;
      stopThemeWatch();
      window.removeEventListener('resize', onResize);
      rive.cleanup();
    };
  } catch {
    // Runtime unavailable — the fallback slot remains visible.
  }
});

onBeforeUnmount(() => {
  teardown?.();
  teardown = null;
});
</script>

<template>
  <div class="doodle-host">
    <div v-if="!ready" class="doodle-fallback"><slot name="fallback" /></div>
    <canvas
      ref="canvasRef"
      class="doodle-canvas"
      :class="{ ready }"
      role="img"
      aria-label="Kimi"
    />
  </div>
</template>

<style scoped>
/* Width comes from the parent; height follows the artboard's 338:152 ratio. */
.doodle-host {
  position: relative;
  width: 100%;
  aspect-ratio: 338 / 152;
  display: flex;
  align-items: center;
  justify-content: center;
}
.doodle-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  opacity: 0;
  transition: opacity 0.25s ease;
}
.doodle-canvas.ready { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .doodle-canvas { transition: none; }
}
</style>
