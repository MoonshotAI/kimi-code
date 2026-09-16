import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The executor is the SEA `kimi` binary published by the native release chain
// (apps/kimi-code/scripts/native): `<cdnBase>/binaries/<version>/manifest.json`
// describes `{version, platforms: {<platform>-<arch>: {filename, checksum}}}`
// and each bare binary sits at `<cdnBase>/binaries/<version>/<filename>`.
// `checksum` is the pinned SHA-256 of the bare binary — the same discipline
// as rgLocator's pinned archive hashes.

export interface ExecutorArtifactTarget {
  readonly osKind: string;
  readonly osArch: string;
}

export interface ExecutorArtifact {
  readonly version: string;
  readonly filename: string;
  readonly url: string;
  readonly sha256: string;
}

export interface ExecutorArtifactLocator {
  locate(target: ExecutorArtifactTarget, version: string): Promise<ExecutorArtifact>;
}

export class ArtifactLocatorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ArtifactLocatorError';
  }
}

// Maps the handshake environment vocabulary (osKind 'Linux'/'macOS', osArch
// 'x64'/'arm64') to the release manifest platform key (`<node platform>-<node
// arch>`). The executor is posix-only, so win32 targets are never selected.
export function releaseTargetKey(target: ExecutorArtifactTarget): string | undefined {
  const platform =
    target.osKind === 'Linux' ? 'linux' : target.osKind === 'macOS' ? 'darwin' : undefined;
  const arch = target.osArch === 'x64' ? 'x64' : target.osArch === 'arm64' ? 'arm64' : undefined;
  if (platform === undefined || arch === undefined) return undefined;
  return `${platform}-${arch}`;
}

interface ManifestPlatformEntry {
  readonly filename: string;
  readonly checksum: string;
}

interface ReleaseManifest {
  readonly version: string;
  readonly platforms: Readonly<Record<string, ManifestPlatformEntry>>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;

function parseManifest(body: unknown, url: string): ReleaseManifest {
  if (body === null || typeof body !== 'object') {
    throw new ArtifactLocatorError(`executor manifest at ${url} is not an object`);
  }
  const version = (body as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new ArtifactLocatorError(`executor manifest at ${url} carries no version`);
  }
  const platforms = (body as { platforms?: unknown }).platforms;
  if (platforms === null || typeof platforms !== 'object') {
    throw new ArtifactLocatorError(`executor manifest at ${url} carries no platforms object`);
  }
  const parsed: Record<string, ManifestPlatformEntry> = {};
  for (const [key, value] of Object.entries(platforms)) {
    if (value === null || typeof value !== 'object') continue;
    const filename = (value as { filename?: unknown }).filename;
    const checksum = (value as { checksum?: unknown }).checksum;
    if (typeof filename !== 'string' || filename.length === 0) continue;
    if (typeof checksum !== 'string' || !SHA256_PATTERN.test(checksum)) continue;
    parsed[key] = { filename, checksum };
  }
  return { version, platforms: parsed };
}

export interface CdnExecutorArtifactLocatorOptions {
  // Region CDN root, e.g. `https://code.kimi.com/kimi-code` — the composition
  // root (kap-server) derives it from the OAuth region profile
  // (`kimiRegionProfile(resolveKimiRegion(...)).cdnBase`).
  readonly cdnBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly manifestTimeoutMs?: number;
}

export class CdnExecutorArtifactLocator implements ExecutorArtifactLocator {
  readonly cdnBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly manifestTimeoutMs: number;

  constructor(options: CdnExecutorArtifactLocatorOptions) {
    this.cdnBaseUrl = options.cdnBaseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.manifestTimeoutMs = options.manifestTimeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS;
  }

  manifestUrl(version: string): string {
    return `${this.cdnBaseUrl}/binaries/${version}/manifest.json`;
  }

  async locate(target: ExecutorArtifactTarget, version: string): Promise<ExecutorArtifact> {
    const key = releaseTargetKey(target);
    if (key === undefined) {
      throw new ArtifactLocatorError(
        `unsupported executor target ${target.osKind}/${target.osArch} ` +
          '(the executor is posix-only; supported targets are linux/darwin on x64/arm64)',
      );
    }
    const url = this.manifestUrl(version);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.manifestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      throw new ArtifactLocatorError(
        `failed to fetch the executor manifest for ${version}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new ArtifactLocatorError(
        `executor manifest for ${version} returned HTTP ${String(response.status)} (${url})`,
      );
    }
    const manifest = parseManifest(await response.json(), url);
    // A stale endpoint answering another release's manifest would apply its
    // checksums to this version's binary and fail every verification.
    if (manifest.version !== version) {
      throw new ArtifactLocatorError(
        `executor manifest for ${version} served content for ${manifest.version} (${url})`,
      );
    }
    const entry = manifest.platforms[key];
    if (entry === undefined) {
      throw new ArtifactLocatorError(
        `platform ${key} is not published in the executor manifest for ${version}`,
      );
    }
    return {
      version,
      filename: entry.filename,
      sha256: entry.checksum,
      url: `${this.cdnBaseUrl}/binaries/${version}/${entry.filename}`,
    };
  }
}

export interface DownloadedExecutorArtifact {
  readonly path: string;
  readonly sizeBytes: number;
}

export interface DownloadExecutorArtifactOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  // Defaults to a fresh `mkdtemp` dir; the caller owns cleanup of the dir.
  readonly destDir?: string;
}

export async function downloadExecutorArtifact(
  artifact: ExecutorArtifact,
  options: DownloadExecutorArtifactOptions = {},
): Promise<DownloadedExecutorArtifact> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const destDir = options.destDir ?? (await mkdtemp(join(tmpdir(), 'kimi-executor-')));
  const destPath = join(destDir, artifact.filename);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(artifact.url, { signal: controller.signal });
  } catch (error) {
    throw new ArtifactLocatorError(
      `failed to download ${artifact.url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || response.body === null) {
    throw new ArtifactLocatorError(
      `executor download from ${artifact.url} returned HTTP ${String(response.status)}`,
    );
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destPath));
  const actualSha256 = createHash('sha256').update(await readFile(destPath)).digest('hex');
  if (actualSha256 !== artifact.sha256) {
    throw new ArtifactLocatorError(
      `executor checksum mismatch for ${artifact.filename}: expected ${artifact.sha256}, ` +
        `got ${actualSha256}. Refusing to install — CDN content may have changed.`,
    );
  }
  const { size } = await stat(destPath);
  return { path: destPath, sizeBytes: size };
}
