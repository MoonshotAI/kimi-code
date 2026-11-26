import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import { KIMI_REGION_PROFILES, type KimiRegion } from './region';

export const CLIENT_CONFIGS_PATH = '/client_configs';
export const RESOURCE_CONFIGS_PATH = '/resource_configs';

const CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface ClientConfigEnvironment {
  readonly region: () => KimiRegion;
  readonly baseUrlOverride: () => string | undefined;
  readonly cacheDir: () => string | undefined;
}

export interface ClientConfigFetchOptions {
  readonly path?: string;
  readonly accessToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly cacheFile?: string | null;
}

interface CacheEntry {
  readonly fetchedAt: number;
  readonly data: unknown;
}

const cacheFileEnvelopeSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number(),
  config: z.unknown(),
});

export class ClientConfigClient {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly environment: ClientConfigEnvironment) {}

  region(): KimiRegion {
    return this.environment.region();
  }

  async get<S extends z.ZodType>(
    name: string,
    schema: S,
    options: ClientConfigFetchOptions = {},
  ): Promise<z.infer<S> | undefined> {
    const now = options.now ?? Date.now();
    const key = this.cacheKeyFor(name, options.path);
    const hit = this.cache.get(key);
    if (hit !== undefined && now - hit.fetchedAt < CONFIG_CACHE_TTL_MS) {
      return hit.data as z.infer<S>;
    }
    const file = this.cacheFileFor(name, options);
    if (file !== undefined) {
      const diskHit = await readDiskCache(file, schema, now);
      if (diskHit !== undefined) {
        this.cache.set(key, diskHit);
        return diskHit.data as z.infer<S>;
      }
    }
    const data = await this.fetch(name, schema, options);
    if (data === undefined) return undefined;
    this.cache.set(key, { fetchedAt: now, data });
    if (file !== undefined) await writeDiskCache(file, data, now);
    return data;
  }

  peek<S extends z.ZodType>(
    name: string,
    schema: S,
    now: number = Date.now(),
    path?: string,
  ): z.infer<S> | undefined {
    const hit = this.cache.get(this.cacheKeyFor(name, path));
    if (hit === undefined || now - hit.fetchedAt >= CONFIG_CACHE_TTL_MS) return undefined;
    const parsed = schema.safeParse(hit.data);
    return parsed.success ? (parsed.data as z.infer<S>) : undefined;
  }

  async fetch<S extends z.ZodType>(
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
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal]);
    try {
      const response = await fetchFn(
        `${this.baseUrl()}${options.path ?? CLIENT_CONFIGS_PATH}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ name }),
          signal,
        },
      );
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

  reset(name?: string, path?: string): void {
    if (name === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(this.cacheKeyFor(name, path));
    }
  }

  private baseUrl(): string {
    const base =
      this.environment.baseUrlOverride() ?? KIMI_REGION_PROFILES[this.region()].baseUrl;
    return base.replace(/\/+$/, '');
  }

  private cacheKeyFor(name: string, path: string | undefined): string {
    return `${this.region()}:${path ?? CLIENT_CONFIGS_PATH}:${name}`;
  }

  private cacheFileFor(name: string, options: ClientConfigFetchOptions): string | undefined {
    if (options.cacheFile === null) return undefined;
    if (options.cacheFile !== undefined) return options.cacheFile;
    const dir = this.environment.cacheDir();
    if (dir === undefined) return undefined;
    return join(dir, `${encodeURIComponent(this.cacheKeyFor(name, options.path))}.json`);
  }
}

async function readDiskCache(
  file: string,
  schema: z.ZodType,
  now: number,
): Promise<CacheEntry | undefined> {
  let envelope: z.infer<typeof cacheFileEnvelopeSchema> | undefined;
  try {
    const raw = await readFile(file, 'utf-8');
    envelope = cacheFileEnvelopeSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
  if (now - envelope.fetchedAt >= CONFIG_CACHE_TTL_MS) return undefined;
  const parsed = schema.safeParse(envelope.config);
  return parsed.success ? { fetchedAt: envelope.fetchedAt, data: parsed.data } : undefined;
}

async function writeDiskCache(file: string, data: unknown, now: number): Promise<void> {
  const tmpPath = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    const parsed = cacheFileEnvelopeSchema.parse({ version: 1, fetchedAt: now, config: data });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    await rename(tmpPath, file);
  } catch {
    await unlink(tmpPath).catch(() => {});
  }
}
