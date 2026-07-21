// Desktop-pet page (pet.html): the official animated 小蓝 mascot — the same
// Rive asset kimi.com renders on canvas (`kimi_avatar_default.riv`, artboard
// "KimiAvator_homepage"; its state machine ships the idle blink/glance loop
// and the click/hover reactions). Plain TS, no framework.
//
// The runtime + wasm are lazy dynamic imports (same pattern as
// components/KimiDoodle.vue); until they arrive — or permanently when they
// fail, or under reduced motion — a static inline-SVG mascot shows instead.
// The only IPC is the three-message drag channel (start/move/end) that lets
// the main process move the window. The pet never talks to the server.

import './pet.css';
import rivUrl from '../assets/pet/kimi_avatar_default.riv?url';
import { fireTrigger, setInputValue, type RiveLike } from './riveInputs';

// State-machine input names inside the asset (from its published strings):
// 'light/dark' number input (0 light / 1 dark), 'click_avator' trigger for
// click reactions, 'hoverspace' boolean for hover. Anything missing no-ops.
const THEME_INPUT = 'light/dark';
const CLICK_TRIGGER = 'click_avator';
const HOVER_INPUT = 'hoverspace';

// --- preload bridge -----------------------------------------------------------

interface ScreenPoint {
  screenX: number;
  screenY: number;
}

interface PetBridge {
  petDragStart: (pos: ScreenPoint) => void;
  petDragMove: (pos: ScreenPoint) => void;
  petDragEnd: () => void;
}

const bridge = (window as unknown as { kimiDesktop?: PetBridge }).kimiDesktop;

// --- static fallback mascot ---------------------------------------------------
//
// The brand blob as a plain inline SVG (paths from `KIMI CODE LOGO/Original
// Logo.svg`, terminal bar and corner mark removed, eyes straightened/levelled
// — see the transform comments below). No animations: this is only the
// placeholder before the Rive runtime is ready, or the permanent stand-in
// when it can't run.

const SVG_NS = 'http://www.w3.org/2000/svg';

const BODY_PATH =
  'M125.388 0C191.877 0 245.776 53.8995 245.776 120.388C245.776 186.877 191.877 240.776 125.388 240.776C58.8996 240.776 5 186.877 5 120.388C5 53.8995 58.8996 0 125.388 0Z';
const EYE_LEFT_PATH =
  'M111.089 73.2179C109.935 64.8166 115.756 57.078 124.091 55.9333C132.426 54.7886 140.117 60.6713 141.271 69.0726L144.785 94.6564C145.939 103.058 140.118 110.796 131.783 111.941C123.449 113.086 115.757 107.203 114.603 98.8018L111.089 73.2179Z';
const EYE_RIGHT_PATH =
  'M174.422 65.1492C173.326 57.1679 178.518 49.8626 186.019 48.8324C193.52 47.8021 200.489 53.4371 201.586 61.4184L204.924 85.723C206.02 93.7042 200.828 101.01 193.327 102.04C185.825 103.07 178.856 97.435 177.76 89.4538L174.422 65.1492Z';

function svgEl(name: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

function buildStaticMascot(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'fallback';
  const svg = svgEl('svg', { viewBox: '5 0 240.776 240.776' });
  const defs = svgEl('defs', {});
  const gradient = svgEl('radialGradient', {
    id: 'pet-body-gradient',
    cx: '0',
    cy: '0',
    r: '1',
    gradientUnits: 'userSpaceOnUse',
    gradientTransform: 'translate(125.388 105.735) scale(121.866)',
  });
  gradient.append(
    svgEl('stop', { 'stop-color': '#117DFB' }),
    svgEl('stop', { 'stop-color': '#449BFF', offset: '0.759254' }),
    svgEl('stop', { 'stop-color': '#77B6FF', offset: '1' }),
  );
  defs.append(gradient);
  const body = svgEl('g', {});
  body.append(
    svgEl('path', { d: BODY_PATH, fill: '#2389FF' }),
    svgEl('path', { d: BODY_PATH, fill: 'url(#pet-body-gradient)' }),
  );
  // Eye pair: recentred (logo gazes at the corner mark), each eye straightened
  // ~7.8° clockwise around its own centre, the right one levelled down 8.5.
  const eyes = svgEl('g', { transform: 'translate(-33.4 0)' });
  const eyeLeft = svgEl('g', { transform: 'rotate(7.8 127.94 83.94)' });
  eyeLeft.append(svgEl('path', { d: EYE_LEFT_PATH, fill: '#FFFFFF' }));
  const eyeRight = svgEl('g', { transform: 'translate(0 8.5) rotate(7.8 189.67 75.44)' });
  eyeRight.append(svgEl('path', { d: EYE_RIGHT_PATH, fill: '#FFFFFF' }));
  eyes.append(eyeLeft, eyeRight);
  svg.append(defs, body, eyes);
  wrap.append(svg);
  return wrap;
}

// --- boot ---------------------------------------------------------------------

const petRootEl = document.getElementById('pet');
if (petRootEl === null) {
  throw new Error('pet root element missing');
}
// Explicitly non-null alias: control-flow narrowing doesn't survive into the
// hoisted async `boot()` closure, the annotated const does.
const root: HTMLElement = petRootEl;

root.append(buildStaticMascot());

type PetRive = RiveLike & {
  play: (stateMachine: string) => void;
  resizeDrawingSurfaceToCanvas: () => void;
};

let rive: PetRive | null = null;

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(): void {
  if (rive !== null) {
    setInputValue(rive, THEME_INPUT, darkQuery.matches ? 1 : 0);
  }
}

async function boot(): Promise<void> {
  // Reduced motion: don't even fetch the runtime, keep the static mascot.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    const [{ Rive, RuntimeLoader }, wasmUrl, wasmFallbackUrl] = await Promise.all([
      import('@rive-app/canvas'),
      import('@rive-app/canvas/rive.wasm?url').then((m) => m.default),
      import('@rive-app/canvas/rive_fallback.wasm?url').then((m) => m.default),
    ]);
    // Both URLs must be local — the defaults pull from jsdelivr/unpkg, which
    // is unreachable offline (the fallback build serves non-SIMD browsers).
    RuntimeLoader.setWasmUrl(wasmUrl);
    RuntimeLoader.setWasmFallbackUrl(wasmFallbackUrl);

    const canvas = document.createElement('canvas');
    canvas.className = 'mascot-canvas';
    root.append(canvas);
    const instance: PetRive = new Rive({
      canvas,
      src: rivUrl,
      autoplay: true,
      onLoad() {
        const stateMachine = instance.stateMachineNames[0];
        if (stateMachine !== undefined) instance.play(stateMachine);
        // stateMachineInputs() returns undefined during the synchronous
        // onLoad callback — defer a frame before touching inputs/resizing.
        requestAnimationFrame(() => {
          applyTheme();
          // Swap first: resizeDrawingSurfaceToCanvas() reads the canvas's CSS
          // size, which is 0×0 while it is still display:none.
          root.classList.add('rive-ready');
          instance.resizeDrawingSurfaceToCanvas(); // bitmap = CSS size × DPR
        });
      },
    });
    rive = instance;
  } catch {
    // Runtime unavailable — the static mascot stays.
  }
}

void boot();
darkQuery.addEventListener('change', applyTheme);

// Hover reaction, when the asset exposes the input.
root.addEventListener('pointerenter', () => {
  if (rive !== null) setInputValue(rive, HOVER_INPUT, true);
});
root.addEventListener('pointerleave', () => {
  if (rive !== null) setInputValue(rive, HOVER_INPUT, false);
});

// Drag + click. The main process moves the window (MouseEvent.screenX/screenY
// are global display coordinates, so the drag offset never drifts); a press
// that never leaves the 4px dead zone is a click and fires the asset's click
// trigger (its state machine picks the reaction: wink / jump / shake / …).
const DRAG_THRESHOLD_PX = 4;

let press: { startX: number; startY: number; dragging: boolean } | null = null;

root.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  press = { startX: event.screenX, startY: event.screenY, dragging: false };
  root.setPointerCapture(event.pointerId);
  bridge?.petDragStart({ screenX: event.screenX, screenY: event.screenY });
});

root.addEventListener('pointermove', (event) => {
  if (press === null) return;
  if (!press.dragging) {
    const moved = Math.hypot(event.screenX - press.startX, event.screenY - press.startY);
    if (moved <= DRAG_THRESHOLD_PX) return;
    press.dragging = true;
    root.classList.add('dragging');
  }
  bridge?.petDragMove({ screenX: event.screenX, screenY: event.screenY });
});

const endPress = (event: PointerEvent, cancelled: boolean): void => {
  if (press === null) return;
  const wasDragging = press.dragging;
  press = null;
  root.classList.remove('dragging');
  if (wasDragging) {
    bridge?.petDragEnd();
  } else if (!cancelled && event.type === 'pointerup' && rive !== null) {
    fireTrigger(rive, CLICK_TRIGGER);
  }
};

root.addEventListener('pointerup', (event) => endPress(event, false));
root.addEventListener('pointercancel', (event) => endPress(event, true));
root.addEventListener('contextmenu', (event) => event.preventDefault());
