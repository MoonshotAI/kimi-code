
export type BackendName = 'default' | 'multi';

export interface DevBackendState {
  current: string;
  presets: Record<BackendName, string>;
}

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

export function shortOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
