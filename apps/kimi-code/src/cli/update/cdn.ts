import { valid } from 'semver';
import { z } from 'zod';

import {
  KIMI_CODE_CDN_BASE,
  KIMI_CODE_CDN_LATEST_JSON_URL,
  KIMI_CODE_CDN_LATEST_URL,
  KIMI_CODE_UPDATE_CDN_BASE_ENV,
} from '#/constant/app';

import type { UpdateManifest } from './types';

/**
 * Resolved per call so tests and local mock CDNs can swap the base via env;
 * without the override the canonical URL constant is used as-is.
 */
function updateCdnUrl(defaultUrl: string): string {
  const override = process.env[KIMI_CODE_UPDATE_CDN_BASE_ENV]?.trim();
  if (override === undefined || override.length === 0) return defaultUrl;
  return `${override}${defaultUrl.slice(KIMI_CODE_CDN_BASE.length)}`;
}

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
): Promise<string> {
  const response = await fetchImpl(updateCdnUrl(KIMI_CODE_CDN_LATEST_URL));
  if (!response.ok) {
    throw new Error(`CDN /latest returned HTTP ${response.status}`);
  }
  const raw = (await response.text()).trim();
  if (valid(raw) === null) {
    throw new Error(`CDN /latest returned invalid semver: ${JSON.stringify(raw)}`);
  }
  return raw;
}

async function fetchUpdateManifestFromCdn(fetchImpl: typeof fetch): Promise<UpdateManifest> {
  const response = await fetchImpl(updateCdnUrl(KIMI_CODE_CDN_LATEST_JSON_URL));
  if (!response.ok) {
    throw new Error(`CDN /latest.json returned HTTP ${response.status}`);
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
): Promise<FetchLatestResult> {
  const manifest = await fetchUpdateManifestFromCdn(fetchImpl).catch(() => null);
  if (manifest !== null) {
    return { latest: manifest.version, manifest };
  }
  const latest = await fetchLatestVersionFromCdn(fetchImpl);
  return { latest, manifest: null };
}
