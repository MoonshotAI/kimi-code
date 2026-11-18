
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

export interface RcDeviceList {
  devices: RcDevice[];
  max_devices?: number;
}

export class RcDevicesFetchError extends Error {
  constructor(readonly status: number) {
    super(`rc devices fetch failed: ${status}`);
    this.name = 'RcDevicesFetchError';
  }
}

export async function fetchRcDevices(): Promise<RcDeviceList> {
  const res = await fetch('/v1/remote/devices', { credentials: 'same-origin' });
  if (!res.ok) throw new RcDevicesFetchError(res.status);
  const body = (await res.json()) as { devices?: RcDevice[]; max_devices?: unknown };
  return {
    devices: Array.isArray(body.devices) ? body.devices : [],
    max_devices: typeof body.max_devices === 'number' ? body.max_devices : undefined,
  };
}

function rcDeviceUrl(deviceId: string, suffix = ''): string {
  return `/v1/remote/devices/${encodeURIComponent(deviceId)}${suffix}`;
}

export async function renameRcDevice(deviceId: string, alias: string): Promise<void> {
  const res = await fetch(rcDeviceUrl(deviceId), {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias }),
  });
  if (!res.ok) throw new RcDevicesFetchError(res.status);
}

export async function deactivateRcDevice(deviceId: string): Promise<void> {
  const res = await fetch(rcDeviceUrl(deviceId, '/deactivate'), {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new RcDevicesFetchError(res.status);
}

export async function deleteRcDevice(deviceId: string): Promise<void> {
  const res = await fetch(rcDeviceUrl(deviceId), {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new RcDevicesFetchError(res.status);
}
