import { kimiCodeBaseUrl } from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

/**
 * Generic client for the public client-configs endpoint:
 * `POST {kimiCodeBaseUrl}/client_configs {"name": "<config name>"}` returns
 * `{ name, config: <payload> }`, where the payload shape is config-specific
 * and validated by the caller-supplied schema.
 *
 * Each named config is cached in-process for a day; a missing/stale entry
 * triggers a refetch. Any failure resolves to `undefined` — callers treat
 * that as "config unavailable" and degrade quietly.
 */
const CLIENT_CONFIGS_PATH = '/client_configs';

/** Process-level cache validity per config name: 1 day. */
const CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface ClientConfigFetchOptions {
  /** Managed OAuth token; sent as Bearer when present. The endpoint is
   *  public, so anonymous fetches work too. */
  readonly accessToken?: string;
  /** Test hook. */
  readonly fetchImpl?: typeof fetch;
  /** Test hook. */
  readonly now?: number;
}

const cache = new Map<string, { readonly fetchedAt: number; readonly data: unknown }>();

/** Returns the named client config, preferring the in-process cache. */
export async function getClientConfig<S extends z.ZodType>(
  name: string,
  schema: S,
  options: ClientConfigFetchOptions = {},
): Promise<z.infer<S> | undefined> {
  const now = options.now ?? Date.now();
  const hit = cache.get(name);
  if (hit !== undefined && now - hit.fetchedAt < CONFIG_CACHE_TTL_MS) {
    return hit.data as z.infer<S>;
  }
  const data = await fetchClientConfig(name, schema, options);
  if (data === undefined) return undefined;
  cache.set(name, { fetchedAt: now, data });
  return data;
}

/** Fire-and-forget refresh of a named config. Never throws. */
export function refreshClientConfigInBackground<S extends z.ZodType>(
  name: string,
  schema: S,
  options: ClientConfigFetchOptions = {},
): void {
  void getClientConfig(name, schema, options).catch(() => undefined);
}

/** Synchronous peek at a fresh cached config; undefined when missing/stale. */
export function peekClientConfig<S extends z.ZodType>(
  name: string,
  schema: S,
  now: number = Date.now(),
): z.infer<S> | undefined {
  const hit = cache.get(name);
  if (hit === undefined || now - hit.fetchedAt >= CONFIG_CACHE_TTL_MS) return undefined;
  const parsed = schema.safeParse(hit.data);
  return parsed.success ? (parsed.data as z.infer<S>) : undefined;
}

export async function fetchClientConfig<S extends z.ZodType>(
  name: string,
  schema: S,
  options: ClientConfigFetchOptions = {},
): Promise<z.infer<S> | undefined> {
  const fetchFn = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (options.accessToken !== undefined) {
    headers['authorization'] = `Bearer ${options.accessToken}`;
  }
  try {
    const response = await fetchFn(`${kimiCodeBaseUrl()}${CLIENT_CONFIGS_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const envelope = body as Record<string, unknown>;
    if (envelope['name'] !== name) return undefined;
    const parsed = schema.safeParse(envelope['config']);
    return parsed.success ? (parsed.data as z.infer<S>) : undefined;
  } catch {
    return undefined;
  }
}

/** Test hook: drop one or all cached configs. */
export function resetClientConfigCache(name?: string): void {
  if (name === undefined) {
    cache.clear();
  } else {
    cache.delete(name);
  }
}
