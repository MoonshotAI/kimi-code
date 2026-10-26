import { gt, valid } from 'semver';
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

/**
 * CDN `latest.json` wire format. Deliberately NOT `.strict()` — unknown
 * fields are ignored so future manifest additions never break shipped
 * clients (the plain-text `/latest` taught us that hard-failing on
 * unexpected content bricks the update path forever).
 */
export const UpdateManifestSchema = z.object({
  version: z.string().refine((value) => valid(value) !== null, { error: 'invalid semver' }),
  publishedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), { error: 'invalid timestamp' }),
  rollout: z.array(RolloutBatchSchema).readonly().default([]),
});

export interface FetchLatestResult {
  /** Raw newest version — what `kimi upgrade` installs, never rollout-gated. */
  readonly latest: string;
  /** Null when the JSON manifest was unavailable and we fell back to plain text. */
  readonly manifest: UpdateManifest | null;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(input, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the latest published Kimi Code version from the CDN.
 *
 * **Throws** on any failure (network error, non-2xx, empty body, non-semver
 * text). Callers must catch — `refreshUpdateCache` deliberately lets the
 * error propagate so the existing cache stays intact instead of being
 * overwritten with a null `latest` on a transient blip.
 *
 * `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 */
export async function fetchLatestVersionFromCdn(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CDN_FETCH_TIMEOUT_MS,
): Promise<string> {
  const response = await fetchWithTimeout(fetchImpl, kimiCodeCdnLatestUrl(), timeoutMs);
  if (!response.ok) {
    throw new Error(`CDN /latest returned HTTP ${response.status}`);
  }
  const raw = (await response.text()).trim();
  if (valid(raw) === null) {
    throw new Error(`CDN /latest returned invalid semver: ${JSON.stringify(raw)}`);
  }
  return raw;
}

async function fetchManifestFromCdn(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<UpdateManifest> {
  const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
  if (!response.ok) {
    throw new Error(`CDN ${url} returned HTTP ${response.status}`);
  }
  return UpdateManifestSchema.parse(JSON.parse(await response.text()));
}

/**
 * Fetch the rollout manifest, falling back to the plain-text `/latest` when
 * `latest.json` is unavailable or malformed. The fallback removes any
 * deployment-order coupling between client releases and the CDN file, and a
 * null manifest means "fully rolled out" — exactly the pre-rollout behavior.
 *
 * **Throws** only when both sources fail; callers must catch (see above).
 */
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
  /** The canary pointer was unreachable, so this is the stable result. */
  readonly degraded: boolean;
}

/**
 * The version a channel should move to right now. Stable is exactly
 * `fetchLatestFromCdn`. Canary reads both feeds in parallel and takes the
 * higher version, so a stable release that overtakes the last canary still
 * reaches canary users; an unreachable canary pointer degrades to the stable
 * result instead of stranding the channel.
 *
 * **Throws** only when every source fails; callers must catch.
 */
export async function fetchChannelFeed(
  channel: UpdateChannel,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CDN_FETCH_TIMEOUT_MS,
): Promise<ChannelFeed> {
  if (channel === 'stable') {
    return { channel, degraded: false, ...(await fetchLatestFromCdn(fetchImpl, timeoutMs)) };
  }
  const [stable, canary] = await Promise.allSettled([
    fetchLatestFromCdn(fetchImpl, timeoutMs),
    fetchManifestFromCdn(fetchImpl, kimiCodeCdnCanaryChannelUrl(), timeoutMs),
  ]);
  if (canary.status === 'rejected') {
    if (stable.status === 'rejected') throw stable.reason;
    return { channel, degraded: true, ...stable.value };
  }
  const pointer = { latest: canary.value.version, manifest: canary.value };
  if (stable.status === 'rejected' || gt(pointer.latest, stable.value.latest)) {
    return { channel, degraded: false, ...pointer };
  }
  return { channel, degraded: false, ...stable.value };
}
