// apps/web/src/lib/rcDevicesApi.ts
//
// The rc relay's device-list endpoint. This is NOT the daemon API: the relay
// serves it at the site root (not under the daemon's /api/v1 prefix) with the
// rc session cookie, so it bypasses the shared DaemonHttpClient transport
// entirely (different base, no envelope). Kept app-side because app-core is a
// pure layer — network I/O does not belong there. The pure URL/query helpers
// stay in app-core's lib/rcDevices.ts.

/** One row of `GET /v1/remote/devices`. */
export interface RcDevice {
  device_id: string;
  alias: string;
  status: 'online' | 'offline';
  platform: string;
  client_version: string;
  local_base_url: string;
  created_at: string;
  updated_at: string;
  last_remote_access_at: string;
}

/** Payload of `GET /v1/remote/devices`: the device rows plus the account's
    device cap (`max_devices`, absent when the relay reports no cap). Parsed
    for the upcoming capacity UI — nothing renders max_devices yet. */
export interface RcDeviceList {
  devices: RcDevice[];
  max_devices?: number;
}

/** Fetch the device list from the relay (same-origin; the rc session cookie
    rides along automatically). Throws on a non-OK response or bad payload. */
export async function fetchRcDevices(): Promise<RcDeviceList> {
  const res = await fetch('/v1/remote/devices', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`rc devices fetch failed: ${res.status}`);
  const body = (await res.json()) as { devices?: RcDevice[]; max_devices?: unknown };
  return {
    devices: Array.isArray(body.devices) ? body.devices : [],
    max_devices: typeof body.max_devices === 'number' ? body.max_devices : undefined,
  };
}
