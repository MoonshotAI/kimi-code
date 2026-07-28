import type { WindowLifecycleEvent } from './telemetry-events';
import { trackDesktopEvent } from './track';

type WindowLifecycleAction = WindowLifecycleEvent['action'];

interface RecordOptions {
  reason?: WindowLifecycleEvent['reason'];
}

let currentAction: WindowLifecycleAction | null = null;
let lastShownAt: number | null = null;

export function recordWindowLifecycle(action: WindowLifecycleAction, options: RecordOptions = {}): void {
  if (currentAction === action) return;
  currentAction = action;
  if (action === 'shown') {
    lastShownAt = Date.now();
    trackDesktopEvent('window_lifecycle', { action });
    return;
  }
  const properties: WindowLifecycleEvent = { action };
  if (options.reason !== undefined) properties.reason = options.reason;
  if (lastShownAt !== null) {
    properties.visible_duration_ms = Math.max(0, Math.round(Date.now() - lastShownAt));
  }
  trackDesktopEvent('window_lifecycle', properties);
}

export function finalizeWindowLifecycle(): void {
  if (currentAction === null || currentAction === 'closed') return;
  recordWindowLifecycle('closed', { reason: 'quit' });
}
