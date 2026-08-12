// apps/desktop/src/renderer/lib/track.ts
// Best-effort renderer entry point; validation lives at the main-process boundary.

import type { ProductTracker } from '@moonshot-ai/app-client/contracts';
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

/** Adapter exposing the typed renderer track() through the app-client
    ProductTracker contract; installed at bootstrap via setProductTracker.
    Shared package code's events bypass this file's compile-time contract —
    the main-process zod schema stays the runtime trust boundary. */
export const productTracker: ProductTracker = {
  track: (event, payload) => track(event as RendererEventName, payload as never),
};
