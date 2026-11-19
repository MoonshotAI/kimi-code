
function readStep(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return Number.parseFloat(raw) || fallback;
}

export function resizeHandleStep(shift: boolean): number {
  return shift
    ? readStep('--resize-handle-step-lg', 48)
    : readStep('--resize-handle-step', 16);
}
