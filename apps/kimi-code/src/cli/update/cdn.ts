import { valid } from 'semver';
import { z } from 'zod';

import {
  kimiCodeCdnCanaryChannelUrl,
  kimiCodeCdnLatestJsonUrl,
  kimiCodeCdnLatestUrl,
} from '#/constant/app';

import type { UpdateChannel, UpdateManifest } from './types';

const CDN_FETCH_TIMEOUT_MS = 3_000;

const RolloutBatchSchema = z.object({
  percent: z.number().int().min(0).max(100),
  delaySeconds: z.number().int().min(0),
});

export const UpdateManifestSchema = z.object({
  version: z.string().refine((value) => valid(value) !== null, { error: 'invalid semver' }),
  publishedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), { error: 'invalid timestamp' }),
  rollout: z.array(RolloutBatchSchema).readonly().default([]),
});

export interface FetchLatestResult {
  readonly latest: string;
  readonly manifest: UpdateManifest | null;
}

async function fetchWithTimeout<T>(
  fetchImpl: typeof fetch,
  input: string,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const operation = (async () => {
    const response = await fetchImpl(input, { signal: controller.signal });
    return read(response);
  })();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLatestVersionFromCdn(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CDN_FETCH_TIMEOUT_MS,
): Promise<string> {
  return fetchWithTimeout(fetchImpl, kimiCodeCdnLatestUrl(), timeoutMs, async (response) => {
    if (!response.ok) {
      throw new Error(`CDN /latest returned HTTP ${response.status}`);
    }
    const raw = (await response.text()).trim();
    if (valid(raw) === null) {
      throw new Error(`CDN /latest returned invalid semver: ${JSON.stringify(raw)}`);
    }
    return raw;
  });
}

async function fetchManifestFromCdn(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<UpdateManifest> {
  return fetchWithTimeout(fetchImpl, url, timeoutMs, async (response) => {
    if (!response.ok) {
      throw new Error(`CDN ${url} returned HTTP ${response.status}`);
    }
    return UpdateManifestSchema.parse(JSON.parse(await response.text()));
  });
}

export async function fetchLatestFromCdn(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CDN_FETCH_TIMEOUT_MS,
): Promise<FetchLatestResult> {
  const manifest = await fetchManifestFromCdn(fetchImpl, kimiCodeCdnLatestJsonUrl(), timeoutMs)
    .catch(() => null);
  if (manifest !== null) {
    return { latest: manifest.version, manifest };
  }
  const latest = await fetchLatestVersionFromCdn(fetchImpl, timeoutMs);
  return { latest, manifest: null };
}

export interface ChannelFeed extends FetchLatestResult {
  readonly channel: UpdateChannel;
}

export async function fetchChannelFeed(
  channel: UpdateChannel,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CDN_FETCH_TIMEOUT_MS,
): Promise<ChannelFeed> {
  if (channel === 'stable') {
    return { channel, ...(await fetchLatestFromCdn(fetchImpl, timeoutMs)) };
  }
  const manifest = await fetchManifestFromCdn(fetchImpl, kimiCodeCdnCanaryChannelUrl(), timeoutMs);
  return { channel, latest: manifest.version, manifest };
}
