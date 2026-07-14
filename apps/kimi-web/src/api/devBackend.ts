// apps/kimi-web/src/api/devBackend.ts
// Dev-only backend switcher client. Talks to the Vite dev-server endpoints
// mounted by `backendSwitcherPlugin` in vite.config.ts:
//   GET  /__kimi-dev/backend          → { current, presets }
//   POST /__kimi-dev/backend { name } → repoint the /api/v1 proxy
// The endpoints only exist on the Vite dev server (not preview, not the
// production same-origin server) — every helper here degrades to a no-op
// outside that environment so callers can stay unconditional in dev-only UI.

export type BackendName = 'default' | 'multi';

export interface DevBackendState {
  /** Current upstream target of the dev proxy, e.g. `http://127.0.0.1:58627`. */
  current: string;
  /** Named presets offered by the switcher menu. */
  presets: Record<BackendName, string>;
}

/** Synchronous initial state from the Vite-injected define (no flicker). */
export function initialDevBackendState(): DevBackendState | null {
  if (!import.meta.env.DEV) return null;
  const presets =
    typeof __KIMI_DEV_BACKENDS__ !== 'undefined' ? __KIMI_DEV_BACKENDS__ : null;
  if (!presets) return null;
  const current =
    typeof __KIMI_DEV_PROXY_TARGET__ !== 'undefined' && __KIMI_DEV_PROXY_TARGET__
      ? __KIMI_DEV_PROXY_TARGET__
      : presets.default;
  return { current, presets };
}

/** Live state from the dev server. Null when the endpoints don't exist. */
export async function fetchDevBackendState(): Promise<DevBackendState | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const res = await fetch('/__kimi-dev/backend');
    if (!res.ok) return null;
    return (await res.json()) as DevBackendState;
  } catch {
    return null;
  }
}

/**
 * Repoint the dev proxy at another backend preset. Returns the new state, or
 * null when the switch failed (caller keeps the old target).
 */
export async function switchDevBackend(name: BackendName): Promise<DevBackendState | null> {
  try {
    const res = await fetch('/__kimi-dev/backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    return (await res.json()) as DevBackendState;
  } catch {
    return null;
  }
}

/** Strip the scheme for a compact display origin, mirroring api/config.ts. */
export function shortOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
