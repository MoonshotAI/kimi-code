<!-- 小蓝 mascot — the official animated brand blob, the same Rive asset
     kimi.com renders as its avatar (assets/mascot/kimi_avatar_default.riv,
     artboard "KimiAvator_homepage"; its state machine ships the idle
     blink/glance loop plus hover/click reactions). The runtime+wasm are lazy
     dynamic imports kept out of the entry chunk (same pattern as
     KimiDoodle.vue); until they arrive — or permanently when they fail, or
     under reduced motion — the static inline-SVG mascot shows instead.

     State-machine inputs are poked defensively via lib/riveInputs (anything
     the asset doesn't expose no-ops): 'light/dark' number follows the app
     theme, 'hoverspace' boolean on hover, 'click_avator' trigger on click. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useIsDark } from '@moonshot-ai/app-core';
import rivUrl from '../assets/mascot/kimi_avatar_default.riv?url';
import { fireTrigger, setInputValue, type RiveLike } from '@moonshot-ai/app-core/lib';

// Input names inside the asset (from its published strings).
const THEME_INPUT = 'light/dark';
const CLICK_TRIGGER = 'click_avator';
const HOVER_INPUT = 'hoverspace';

type MascotRive = RiveLike & {
  play: (stateMachine: string) => void;
  resizeDrawingSurfaceToCanvas: () => void;
  cleanup: () => void;
};

const ready = ref(false);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isDark = useIsDark();
let rive: MascotRive | null = null;
let teardown: (() => void) | null = null;

function applyTheme(): void {
  if (rive !== null) setInputValue(rive, THEME_INPUT, isDark.value ? 1 : 0);
}

onMounted(async () => {
  // Reduced motion: don't even fetch the runtime, keep the static mascot.
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

    const instance: MascotRive = new Rive({
      canvas,
      src: rivUrl,
      autoplay: true,
      onLoad() {
        const stateMachine = instance.stateMachineNames[0];
        if (stateMachine !== undefined) instance.play(stateMachine);
        // stateMachineInputs() returns undefined during the synchronous
        // onLoad callback — defer a frame before touching inputs/resizing.
        requestAnimationFrame(() => {
          if (!canvasRef.value) return;
          applyTheme();
          instance.resizeDrawingSurfaceToCanvas(); // bitmap = CSS size × DPR
          ready.value = true;
        });
      },
    });
    rive = instance;

    const stopThemeWatch = watch(isDark, applyTheme);
    const onResize = () => instance.resizeDrawingSurfaceToCanvas();
    window.addEventListener('resize', onResize);
    teardown = () => {
      stopThemeWatch();
      window.removeEventListener('resize', onResize);
      instance.cleanup();
      rive = null;
    };
  } catch {
    // Runtime unavailable — the static mascot stays.
  }
});

onBeforeUnmount(() => {
  teardown?.();
  teardown = null;
});

function onHover(hovering: boolean): void {
  if (rive !== null) setInputValue(rive, HOVER_INPUT, hovering);
}

function onClick(): void {
  if (rive !== null) fireTrigger(rive, CLICK_TRIGGER);
}
</script>

<template>
  <div
    class="mascot-host"
    role="img"
    aria-label="Kimi mascot"
    @pointerenter="onHover(true)"
    @pointerleave="onHover(false)"
    @click="onClick"
  >
    <!-- Static stand-in until the Rive canvas is ready (and permanently when
         the runtime can't run): the brand blob as plain inline SVG (paths
         from `KIMI CODE LOGO/Original Logo.svg`, terminal bar and corner mark
         removed, eyes straightened/levelled — see the transforms below). -->
    <svg
      v-if="!ready"
      class="mascot-fallback"
      viewBox="5 0 240.776 240.776"
      aria-hidden="true"
    >
      <defs>
        <radialGradient
          id="mascot-body-gradient"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(125.388 105.735) scale(121.866)"
        >
          <stop stop-color="#117DFB" />
          <stop stop-color="#449BFF" offset="0.759254" />
          <stop stop-color="#77B6FF" offset="1" />
        </radialGradient>
      </defs>
      <g>
        <path
          d="M125.388 0C191.877 0 245.776 53.8995 245.776 120.388C245.776 186.877 191.877 240.776 125.388 240.776C58.8996 240.776 5 186.877 5 120.388C5 53.8995 58.8996 0 125.388 0Z"
          fill="#2389FF"
        />
        <path
          d="M125.388 0C191.877 0 245.776 53.8995 245.776 120.388C245.776 186.877 191.877 240.776 125.388 240.776C58.8996 240.776 5 186.877 5 120.388C5 53.8995 58.8996 0 125.388 0Z"
          fill="url(#mascot-body-gradient)"
        />
      </g>
      <!-- Eye pair: recentred (the logo gazes at the corner mark), each eye
           straightened ~7.8° clockwise around its own centre, the right one
           levelled down 8.5. -->
      <g transform="translate(-33.4 0)">
        <g transform="rotate(7.8 127.94 83.94)">
          <path
            d="M111.089 73.2179C109.935 64.8166 115.756 57.078 124.091 55.9333C132.426 54.7886 140.117 60.6713 141.271 69.0726L144.785 94.6564C145.939 103.058 140.118 110.796 131.783 111.941C123.449 113.086 115.757 107.203 114.603 98.8018L111.089 73.2179Z"
            fill="#FFFFFF"
          />
        </g>
        <g transform="translate(0 8.5) rotate(7.8 189.67 75.44)">
          <path
            d="M174.422 65.1492C173.326 57.1679 178.518 49.8626 186.019 48.8324C193.52 47.8021 200.489 53.4371 201.586 61.4184L204.924 85.723C206.02 93.7042 200.828 101.01 193.327 102.04C185.825 103.07 178.856 97.435 177.76 89.4538L174.422 65.1492Z"
            fill="#FFFFFF"
          />
        </g>
      </g>
    </svg>
    <canvas ref="canvasRef" class="mascot-canvas" :class="{ ready }" />
  </div>
</template>

<style scoped>
/* Width comes from the parent; height follows the artboard's 72:100 ratio. */
.mascot-host {
  position: relative;
  width: 100%;
  aspect-ratio: 72 / 100;
}
/* Sized to roughly the blob's rendered footprint inside the Rive artboard
   (~60/72 of the canvas). */
.mascot-fallback {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: block;
  width: 86.5%;
  height: auto;
}
.mascot-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  opacity: 0;
  transition: opacity 0.25s ease;
}
.mascot-canvas.ready { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .mascot-canvas { transition: none; }
}
</style>
