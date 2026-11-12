import type { HostBridgeManager } from './hostBridgeManager';
import type { HostSession } from './hostSession';

export type HostQuery = Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;

export interface HostSource {
  readonly id: string;
  readonly session: HostSession | undefined;
}

export interface HostSources {
  sources(): HostSource[];
}

export class HostSourceError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'HostSourceError';
  }
}

export function hostSources(manager: HostBridgeManager): HostSources {
  return {
    sources: () =>
      manager.list().map((info) => ({
        id: info.id,
        session: info.entry.enabled === false ? undefined : info.bridge?.session,
      })),
  };
}

function queryString(query: HostQuery): string {
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

export async function hostGet<T>(session: HostSession, path: string, query: HostQuery = {}): Promise<T> {
  const response = await session.request({
    method: 'GET',
    path: `${path}${queryString(query)}`,
    headers: { accept: 'application/json' },
  });
  let body: { code?: number; msg?: string; data?: T };
  try {
    body = JSON.parse(response.body.toString('utf8')) as typeof body;
  } catch {
    throw new HostSourceError(undefined, `host responded with HTTP ${String(response.status)}`);
  }
  if (response.status !== 200 || body.code !== 0 || body.data === undefined) {
    throw new HostSourceError(body.code, body.msg ?? `host responded with HTTP ${String(response.status)}`);
  }
  return body.data;
}

export async function hostProjects<T extends { readonly kind: string }>(session: HostSession): Promise<T[]> {
  const data = await hostGet<{ items: T[] }>(session, '/api/v1/workspaces');
  return data.items.filter((workspace) => workspace.kind === 'managed');
}

export interface HostCollection<T> {
  readonly items: (T & { readonly host_id: string })[];
  readonly unavailable: string[];
}

export async function collectFromHosts<T extends object>(
  hosts: HostSources,
  fetch: (session: HostSession) => Promise<readonly T[]>,
): Promise<HostCollection<T>> {
  const results = await Promise.all(
    hosts.sources().map(async (source) => {
      if (source.session === undefined) return { id: source.id, items: undefined };
      try {
        const items = await fetch(source.session);
        return { id: source.id, items: items.map((item) => ({ ...item, host_id: source.id })) };
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

export type HostLookup<T> =
  | { readonly found: T & { readonly host_id: string } }
  | { readonly found: undefined; readonly unavailable: string[] };

export async function findOnHosts<T extends object>(
  hosts: HostSources,
  fetch: (session: HostSession) => Promise<T | undefined>,
): Promise<HostLookup<T>> {
  const results = await Promise.all(
    hosts.sources().map(async (source) => {
      if (source.session === undefined) return { id: source.id, reachable: false, item: undefined };
      try {
        return { id: source.id, reachable: true, item: await fetch(source.session) };
      } catch {
        return { id: source.id, reachable: false, item: undefined };
      }
    }),
  );
  const hit = results.find((result) => result.item !== undefined);
  if (hit?.item !== undefined) return { found: { ...hit.item, host_id: hit.id } };
  return { found: undefined, unavailable: results.filter((result) => !result.reachable).map((result) => result.id) };
}
