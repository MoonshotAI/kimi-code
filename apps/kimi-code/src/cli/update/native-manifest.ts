/**
 * Per-release native artifact manifest (`/binaries/<version>/manifest.json`).
 *
 * Published alongside the release and consumed by the install scripts; the
 * staged updater reuses the same file so checksums and file names have a
 * single source of truth. Entries point at the bare platform binary
 * (`kimi-code-<target>[.exe]`), not an archive.
 */

import { valid } from 'semver';
import { z } from 'zod';

import { kimiCodeCdnBinariesBase } from '#/constant/app';

const MANIFEST_FETCH_TIMEOUT_MS = 10_000;

const PlatformEntrySchema = z.object({
  filename: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/, { error: 'invalid sha256' }),
});

/**
 * Deliberately NOT `.strict()` — unknown fields are ignored so future
 * manifest additions never break shipped clients (same contract philosophy
 * as the rollout manifest in `cdn.ts`).
 */
export const NativeReleaseManifestSchema = z.object({
  version: z.string().refine((value) => valid(value) !== null, { error: 'invalid semver' }),
  platforms: z.record(z.string(), PlatformEntrySchema),
});

export type NativeReleaseManifest = z.infer<typeof NativeReleaseManifestSchema>;
export type NativePlatformEntry = z.infer<typeof PlatformEntrySchema>;

export function nativeManifestUrl(version: string): string {
  return `${kimiCodeCdnBinariesBase()}/${version}/manifest.json`;
}

export function nativeBinaryUrl(version: string, filename: string): string {
  return `${kimiCodeCdnBinariesBase()}/${version}/${filename}`;
}

/**
 * Fetch and parse the per-release manifest. **Throws** on any failure
 * (network, non-2xx, malformed body, unknown version) — callers treat a
 * throw as "staging failed" and record an install failure.
 *
 * `version` goes into the URL, so it must be a valid semver (it always is:
 * upstream sources are the CDN `latest.json` / the `upgrade` command).
 * `fetchImpl` is injectable for tests.
 */
export async function fetchNativeReleaseManifest(
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NativeReleaseManifest> {
  if (valid(version) === null) {
    throw new Error(`invalid semver for native manifest lookup: ${JSON.stringify(version)}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, MANIFEST_FETCH_TIMEOUT_MS);
  // The timeout must stay armed until the BODY is fully consumed: a CDN or
  // proxy can deliver headers within the limit and then stall mid-body, and
  // resolving `fetch()` alone would clear the timer and hang the worker.
  try {
    const response = await fetchImpl(nativeManifestUrl(version), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`native manifest for ${version} returned HTTP ${response.status}`);
    }
    const manifest = NativeReleaseManifestSchema.parse(JSON.parse(await response.text()));
    // A stale or mispublished endpoint can answer with ANOTHER release's
    // manifest: its checksums would then be applied to this version's binary
    // and every download would fail verification. Reject the mismatch here.
    if (manifest.version !== version) {
      throw new Error(`manifest for ${version} served content for ${manifest.version}`);
    }
    return manifest;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pick the entry for the running platform. The release pipeline keys
 * platforms by `<node platform>-<node arch>` (win32-x64, darwin-arm64, …).
 * **Throws** when the platform is missing — a silent skip would strand the
 * update in a retry loop.
 */
export function selectPlatformEntry(
  manifest: NativeReleaseManifest,
  platform: NodeJS.Platform,
  arch: string,
): NativePlatformEntry {
  const target = `${platform}-${arch}`;
  const entry = manifest.platforms[target];
  if (entry === undefined) {
    throw new Error(`platform ${target} not found in native manifest for ${manifest.version}`);
  }
  return entry;
}
