import { valid } from 'semver';
import { z } from 'zod';

import { kimiCodeCdnBinariesBase } from '#/constant/app';

const MANIFEST_FETCH_TIMEOUT_MS = 10_000;

const PlatformEntrySchema = z.object({
  filename: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/, { error: 'invalid sha256' }),
  zstd: z
    .object({
      file: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/, { error: 'invalid sha256' }),
    })
    .optional(),
  compressed: z
    .object({
      filename: z.string().min(1),
      checksum: z.string().regex(/^[a-f0-9]{64}$/, { error: 'invalid sha256' }),
    })
    .optional(),
});

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
  try {
    const response = await fetchImpl(nativeManifestUrl(version), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`native manifest for ${version} returned HTTP ${response.status}`);
    }
    const manifest = NativeReleaseManifestSchema.parse(JSON.parse(await response.text()));
    if (manifest.version !== version) {
      throw new Error(`manifest for ${version} served content for ${manifest.version}`);
    }
    return manifest;
  } finally {
    clearTimeout(timeout);
  }
}

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
