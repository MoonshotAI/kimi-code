// apps/desktop/src/renderer/lib/track.ts
// Best-effort renderer entry point; validation lives at the main-process boundary.

import type { RendererEventName, RendererEventPayloads } from '../../shared/track-events';

interface TrackBridge {
  track?: (event: string, properties?: object) => void;
}

// Typed against the shared contract so a mistyped event name or payload fails
// here at compile time; the main-process whitelist stays the runtime boundary.
export function track<K extends RendererEventName>(
  event: K,
  properties: RendererEventPayloads[K],
): void {
  try {
    (window as { kimiDesktop?: TrackBridge }).kimiDesktop?.track?.(event, properties);
  } catch {
    // Telemetry must not break UI actions.
  }
}
