// apps/desktop/src/renderer/lib/track.ts
// Desktop-only renderer telemetry: forwards to the preload bridge's `track`
// (`kimi:track` → the main process's cloud pipeline). The event whitelist and
// per-field payload validation live main-side (src/main/track.ts) — this is
// just the fire-and-forget entry point. Without the bridge (web snapshot,
// tests) every call is a silent no-op. Like lib/keymap.ts, this file is NOT
// synced to apps/web (docs/native-todos.md).

interface TrackBridge {
  track?: (event: string, properties?: Record<string, unknown>) => void;
}

/** Emit a telemetry event through the desktop bridge. Best-effort: a missing
 *  or failing bridge drops the event — telemetry must never break the UI. */
export function track(event: string, properties?: Record<string, unknown>): void {
  try {
    (window as { kimiDesktop?: TrackBridge }).kimiDesktop?.track?.(event, properties);
  } catch {
    // Bridge failure: drop the event.
  }
}
