import type { WindowLifecycleEvent } from './telemetry-events';
import { trackDesktopEvent } from './track';

type WindowLifecycleAction = WindowLifecycleEvent['action'];

let currentAction: WindowLifecycleAction | null = null;

export function recordWindowLifecycle(action: WindowLifecycleAction): void {
  if (currentAction === action) return;
  currentAction = action;
  trackDesktopEvent('window_lifecycle', { action });
}

export function replayWindowLifecycle(): void {
  if (currentAction === null) return;
  trackDesktopEvent('window_lifecycle', { action: currentAction });
}

export function finalizeWindowLifecycle(): void {
  if (currentAction === null || currentAction === 'closed') return;
  recordWindowLifecycle('closed');
}
