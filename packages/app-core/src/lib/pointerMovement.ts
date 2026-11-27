let prevX = -1;
let prevY = -1;
let curX = -1;
let curY = -1;
let armed = false;
let installed = false;

function invalidatePointerPosition(): void {
  prevX = -1;
  prevY = -1;
  curX = -1;
  curY = -1;
  armed = false;
}

function onMove(event: PointerEvent): void {
  const hadBaseline = curX >= 0;
  prevX = curX;
  prevY = curY;
  curX = event.clientX;
  curY = event.clientY;
  if (hadBaseline && (curX !== prevX || curY !== prevY)) armed = true;
}

export function ensurePointerTracking(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  window.addEventListener('blur', invalidatePointerPosition);
  document.documentElement.addEventListener('pointerleave', invalidatePointerPosition);
}

export function isSyntheticPointerMove(event: PointerEvent): boolean {
  if (!armed) return true;
  return event.clientX === prevX && event.clientY === prevY;
}

export function lastPointerPosition(): { x: number; y: number } {
  return { x: curX, y: curY };
}
