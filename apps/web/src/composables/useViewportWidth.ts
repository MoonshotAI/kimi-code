// apps/kimi-web/src/composables/useViewportWidth.ts
// Shared reactive viewport width for the resizable layout panels. A single
// window resize listener backs every consumer, so panels can cap themselves to
// the current window size without each wiring up their own listener.

import { onBeforeUnmount, onMounted, ref } from 'vue';

const viewportWidth = ref(typeof window === 'undefined' ? 0 : window.innerWidth);
let subscribers = 0;
let listening = false;

function update(): void {
  viewportWidth.value = window.innerWidth;
}

function startListening(): void {
  if (listening || typeof window === 'undefined') return;
  window.addEventListener('resize', update);
  listening = true;
  update();
}

function stopListening(): void {
  if (!listening || typeof window === 'undefined') return;
  window.removeEventListener('resize', update);
  listening = false;
}

/** Largest a panel may grow while keeping `reserve` px free for the rest of the
 *  layout. Never drops below the panel's own `min`. */
export function panelMaxWidth(available: number, min: number, reserve: number): number {
  return Math.max(min, available - reserve);
}

/** Clamp a panel's chosen width into its allowed [min, max] range. */
export function clampPanelWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, width));
}

export function useViewportWidth() {
  onMounted(() => {
    subscribers += 1;
    startListening();
  });
  onBeforeUnmount(() => {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0) stopListening();
  });
  return { viewportWidth };
}
