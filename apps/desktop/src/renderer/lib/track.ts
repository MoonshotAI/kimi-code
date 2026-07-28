// apps/desktop/src/renderer/lib/track.ts
// Best-effort renderer entry point; validation lives at the main-process boundary.

interface TrackBridge {
  track?: (event: string, properties?: Record<string, unknown>) => void;
}

export function track(event: string, properties?: Record<string, unknown>): void {
  try {
    (window as { kimiDesktop?: TrackBridge }).kimiDesktop?.track?.(event, properties);
  } catch {
    // Telemetry must not break UI actions.
  }
}
