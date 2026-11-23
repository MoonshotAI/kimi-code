
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

export function panelMaxWidth(available: number, min: number, reserve: number): number {
  return Math.max(min, available - reserve);
}

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
