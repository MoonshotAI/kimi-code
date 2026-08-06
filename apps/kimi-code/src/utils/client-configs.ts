import { join } from 'node:path';

import { kimiCodeBaseUrl } from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

import { getCacheDir } from '#/utils/paths';
import { readJsonFile, writeJsonFile } from '#/utils/persistence';

/**
 * Generic client for the public client-configs endpoint:
 * `POST {kimiCodeBaseUrl}/client_configs {"name": "<config name>"}` returns
 * `{ name, config: <payload> }`, where the payload shape is config-specific
 * and validated by the caller-supplied schema.
 *
 * Each named config is cached for a day, in two layers: an in-process map
 * (the only layer the synchronous peek can see) and a JSON file under the
 * CLI cache dir (survives restarts, so the TTL holds across processes). An
 * entry missing/stale in both layers triggers a refetch. Any failure
 * resolves to `undefined` — callers treat that as "config unavailable" and
 * degrade quietly.
 */
const CLIENT_CONFIGS_PATH = '/client_configs';

/** Cache validity per config name: 1 day. */
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
  /** Test hook: override the cache file path, or null to skip the disk
   *  layer entirely. */
  readonly cacheFile?: string | null;
}

const cache = new Map<string, { readonly fetchedAt: number; readonly data: unknown }>();

const cacheFileEnvelopeSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number(),
  config: z.unknown(),
});

function cacheFileFor(name: string, options: ClientConfigFetchOptions): string | undefined {
  if (options.cacheFile === null) return undefined;
  if (options.cacheFile !== undefined) return options.cacheFile;
  return join(getCacheDir(), 'client-configs', `${name.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

/** Fresh disk entry, or undefined when missing/stale/invalid. */
async function readDiskCache<S extends z.ZodType>(
  file: string,
  schema: S,
  now: number,
): Promise<{ readonly fetchedAt: number; readonly data: z.infer<S> } | undefined> {
  let envelope: z.infer<typeof cacheFileEnvelopeSchema>;
  try {
    // The sentinel's fetchedAt=0 reads as stale, i.e. missing.
    envelope = await readJsonFile(file, cacheFileEnvelopeSchema, {
      version: 1,
      fetchedAt: 0,
      config: undefined,
    });
  } catch {
    return undefined; // malformed cache file — treat as missing
  }
  if (now - envelope.fetchedAt >= CONFIG_CACHE_TTL_MS) return undefined;
  const parsed = schema.safeParse(envelope.config);
  return parsed.success
    ? { fetchedAt: envelope.fetchedAt, data: parsed.data as z.infer<S> }
    : undefined;
}

/** Best-effort persist; a cache write failure must never break the caller. */
async function writeDiskCache(file: string, data: unknown, now: number): Promise<void> {
  try {
    await writeJsonFile(file, cacheFileEnvelopeSchema, {
      version: 1,
      fetchedAt: now,
      config: data,
    });
  } catch {
    // A cache that cannot be written just means the next process refetches.
  }
}

/** Returns the named client config, preferring the caches over the network. */
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
  const file = cacheFileFor(name, options);
  if (file !== undefined) {
    const diskHit = await readDiskCache(file, schema, now);
    if (diskHit !== undefined) {
      // Warm the in-process layer with the original fetch time, so the entry
      // still expires a day after it was actually fetched.
      cache.set(name, diskHit);
      return diskHit.data;
    }
  }
  const data = await fetchClientConfig(name, schema, options);
  if (data === undefined) return undefined;
  cache.set(name, { fetchedAt: now, data });
  if (file !== undefined) await writeDiskCache(file, data, now);
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

/**
 * Synchronous peek at the fresh in-process cache; undefined when missing or
 * stale. Only sees the in-process layer — the disk layer is read by the
 * async `getClientConfig`, which warms this layer.
 */
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

/**
 * Test hook: drop one or all in-process cached configs. Disk files in tests
 * are isolated via the `cacheFile` option.
 */
export function resetClientConfigCache(name?: string): void {
  if (name === undefined) {
    cache.clear();
  } else {
    cache.delete(name);
  }
}
