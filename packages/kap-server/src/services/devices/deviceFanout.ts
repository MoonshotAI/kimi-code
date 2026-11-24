import type { DeviceSession } from './deviceSession';

export type DeviceQuery = Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;

const DEVICE_PROJECTS_TIMEOUT_MS = 5_000;

export interface DeviceSource {
  readonly id: string;
  getSession(): Promise<DeviceSession | undefined>;
}

export interface DeviceSources {
  sources(): DeviceSource[];
}

export class DeviceSourceError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceSourceError';
  }
}

function queryString(query: DeviceQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (typeof value === 'object') {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export function deviceGet<T>(
  session: DeviceSession,
  path: string,
  query: DeviceQuery = {},
  timeoutMs?: number,
): Promise<T> {
  return deviceRequest<T>(session, 'GET', `${path}${queryString(query)}`, timeoutMs);
}

export async function deviceRequest<T>(
  session: DeviceSession,
  method: string,
  path: string,
  timeoutMs?: number,
): Promise<T> {
  const response = await session.request({ method, path, headers: { accept: 'application/json' }, timeoutMs });
  let body: { code?: number; msg?: string; data?: T };
  try {
    body = JSON.parse(response.body.toString('utf8')) as typeof body;
  } catch {
    throw new DeviceSourceError(undefined, `device responded with HTTP ${String(response.status)}`);
  }
  if (response.status !== 200 || body.code !== 0 || body.data === undefined) {
    throw new DeviceSourceError(body.code, body.msg ?? `device responded with HTTP ${String(response.status)}`);
  }
  return body.data;
}

export async function deviceProjects<T extends { readonly kind: string }>(session: DeviceSession): Promise<T[]> {
  const data = await deviceGet<{ items: T[] }>(session, '/api/v1/workspaces', {}, DEVICE_PROJECTS_TIMEOUT_MS);
  return data.items.filter((workspace) => workspace.kind === 'managed');
}

export interface DeviceCollection<T> {
  readonly items: (T & { readonly device_id: string })[];
  readonly unavailable: string[];
}

export async function collectFromDevices<T extends object>(
  devices: DeviceSources,
  fetch: (session: DeviceSession) => Promise<readonly T[]>,
): Promise<DeviceCollection<T>> {
  const results = await Promise.all(
    devices.sources().map(async (source) => {
      const session = await source.getSession();
      if (session === undefined) return { id: source.id, items: undefined };
      try {
        const items = await fetch(session);
        return { id: source.id, items: items.map((item) => ({ ...item, device_id: source.id })) };
      } catch {
        return { id: source.id, items: undefined };
      }
    }),
  );
  return {
    items: results.flatMap((result) => result.items ?? []),
    unavailable: results.filter((result) => result.items === undefined).map((result) => result.id),
  };
}

export type DeviceLookup<T> =
  | { readonly found: T & { readonly device_id: string } }
  | { readonly found: undefined; readonly unavailable: string[] };

export async function findOnDevices<T extends object>(
  devices: DeviceSources,
  fetch: (session: DeviceSession) => Promise<T | undefined>,
): Promise<DeviceLookup<T>> {
  const results = await Promise.all(
    devices.sources().map(async (source) => {
      const session = await source.getSession();
      if (session === undefined) return { id: source.id, reachable: false, item: undefined };
      try {
        return { id: source.id, reachable: true, item: await fetch(session) };
      } catch {
        return { id: source.id, reachable: false, item: undefined };
      }
    }),
  );
  const hit = results.find((result) => result.item !== undefined);
  if (hit?.item !== undefined) return { found: { ...hit.item, device_id: hit.id } };
  return { found: undefined, unavailable: results.filter((result) => !result.reachable).map((result) => result.id) };
}
