import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { kimiRegionProfile, resolveKimiRegion, type KimiRegion } from '@moonshot-ai/kimi-code-oauth';
import { extract as extractTar } from 'tar';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';
import { basename, dirname, join } from 'pathe';

import { abortable } from '#/_base/utils/abort';
import { ErrorCodes, Error2 } from '#/errors';
import { LOCAL_ENVIRONMENT_ID, type Environment } from '#/environment/environment';
import { getShareBinRgPath, isRemoteEnvironment, shareBinRgPath } from '#/environment/shareBinRg';
import { hasOhosElfCodeSign, isElfBinary, selfSignOhosElf } from './ohosElfCodeSign';

export { getShareBinRgPath } from '#/environment/shareBinRg';

const RG_VERSION = '15.0.0';
const OHOS_RG_VERSION = '15.1.0';
const OHOS_RG_TARGET = 'aarch64-unknown-linux-ohos';
const OHOS_RG_ARCHIVE_URL =
  'https://raw.atomgit.com/OpenHarmonyPCDeveloper/ohos-ripgrep/blobs/82766f57856322add0eb7bb393b1393ef58190c8/output/ripgrep_15.1.0.tar.gz';
const DOWNLOAD_TIMEOUT_MS = 600_000;
const RG_ARCHIVE_SHA256: Record<string, string> = {
  'ripgrep-15.0.0-aarch64-apple-darwin.tar.gz':
    '98bb2e61e7277ba0ea72d2ae2592497fd8d2940934a16b122448d302a6637e3b',
  'ripgrep-15.1.0-aarch64-unknown-linux-ohos.tar.gz':
    '65932fb647372a27d699eceebbb87186e5c1034c2a7ccdee007648a883362908',
  'ripgrep-15.0.0-aarch64-pc-windows-msvc.zip':
    '572709c8770cb7f9385d725cb06d2bcd9537ec24d4dd17b1be1d65a876f8b591',
  'ripgrep-15.0.0-aarch64-unknown-linux-gnu.tar.gz':
    '15f8cc2fab12d88491c54d49f38589922a9d6a7353c29b0a0856727bcdf80754',
  'ripgrep-15.0.0-x86_64-apple-darwin.tar.gz':
    '44128c733d127ddbda461e01225a68b5f9997cfe7635242a797f645ca674a71a',
  'ripgrep-15.0.0-x86_64-pc-windows-msvc.zip':
    '21a98bf42c4da97ca543c010e764cc6dec8b9b7538d05f8d21874016385e0860',
  'ripgrep-15.0.0-x86_64-unknown-linux-musl.tar.gz':
    '253ad0fd5fef0d64cba56c70dccdacc1916d4ed70ad057cc525fcdb0c3bbd2a7',
};

export type RgResolutionSource =
  | 'system-path'
  | 'vendor'
  | 'share-bin-cached'
  | 'share-bin-downloaded';

export interface RgResolution {
  readonly path: string;
  readonly source: RgResolutionSource;
}

export interface RgProbe {
  exec(args: readonly string[]): Promise<{ readonly exitCode: number }>;
}

export interface EnsureRgPathOptions {
  readonly shareDir?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly allowCachedFallback?: boolean;
  readonly environment?: Environment | undefined;
  readonly resolveRegion?: () => KimiRegion | undefined;
}

function rgBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function getShareDir(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.kimi-code');
}

function rgBaseUrl(resolveRegion: (() => KimiRegion | undefined) | undefined): string {
  const region = resolveRegion?.() ?? resolveKimiRegion();
  return `${kimiRegionProfile(region).cdnBase}/rg`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

export async function ensureRgPath(
  probe: RgProbe,
  options: EnsureRgPathOptions = {},
): Promise<RgResolution> {
  throwIfAborted(options.signal);
  const environment = options.environment;
  if (environment !== undefined && environment.identity.environmentId !== LOCAL_ENVIRONMENT_ID) {
    const resolution = ensureRemoteRgPath(probe, environment, options);
    return options.signal === undefined ? resolution : abortable(resolution, options.signal);
  }
  const shareDir = options.shareDir ?? getShareDir();
  const resolution = resolveRgPath(probe, shareDir, options);
  return options.signal === undefined ? resolution : abortable(resolution, options.signal);
}

async function resolveRgPath(
  probe: RgProbe,
  shareDir: string,
  options: EnsureRgPathOptions,
): Promise<RgResolution> {
  const existing = await findExistingRg(probe, shareDir, options.allowCachedFallback === true);
  if (existing) {
    if (
      detectTarget() === OHOS_RG_TARGET &&
      (existing.source === 'system-path' || existing.source === 'share-bin-cached')
    ) {
      const bytes = await readFile(existing.path);
      if (isElfBinary(bytes) && !hasOhosElfCodeSign(bytes)) {
        const binPath = await stageAndInstallRg(join(shareDir, 'bin'), (staged) =>
          writeFile(staged, selfSignOhosElf(bytes)),
        );
        return { path: binPath, source: 'share-bin-cached' };
      }
    }
    return existing;
  }
  throwIfAborted(options.signal);
  if (options.allowCachedFallback === true) {
    return downloadRgWithLock(probe, shareDir, options.resolveRegion);
  }
  throw new Error2(ErrorCodes.OS_FS_UNAVAILABLE, 'ripgrep (rg) is not available on PATH');
}

const remoteRgResolutions = new Map<string, Promise<RgResolution>>();

function ensureRemoteRgPath(
  probe: RgProbe,
  environment: Environment,
  options: EnsureRgPathOptions,
): Promise<RgResolution> {
  const key = `${environment.identity.environmentId} ${environment.identity.generation}`;
  let pending = remoteRgResolutions.get(key);
  if (pending === undefined) {
    pending = resolveRemoteRgPath(probe, environment, options).catch((error: unknown) => {
      remoteRgResolutions.delete(key);
      throw error;
    });
    remoteRgResolutions.set(key, pending);
  }
  return pending;
}

async function resolveRemoteRgPath(
  probe: RgProbe,
  environment: Environment,
  options: EnsureRgPathOptions,
): Promise<RgResolution> {
  throwIfAborted(options.signal);
  const system = await probe.exec(['rg', '--version']).catch(() => ({ exitCode: -1 }));
  if (system.exitCode === 0) return { path: 'rg', source: 'system-path' };
  if (options.allowCachedFallback !== true) {
    throw new Error2(ErrorCodes.OS_FS_UNAVAILABLE, 'ripgrep (rg) is not available on PATH');
  }
  throwIfAborted(options.signal);
  const binPath = shareBinRgPath(environment);
  const binDir = environment.path?.dirname(binPath) ?? dirname(binPath);
  const cached = await probe.exec([binPath, '--version']).catch(() => ({ exitCode: -1 }));
  if (cached.exitCode === 0) return { path: binPath, source: 'share-bin-cached' };
  throwIfAborted(options.signal);
  await installRemoteRg(probe, environment, binDir, binPath, options.resolveRegion);
  const installed = await probe.exec([binPath, '--version']).catch(() => ({ exitCode: -1 }));
  if (installed.exitCode !== 0) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      `ripgrep was installed to ${binPath} but failed to run`,
    );
  }
  return { path: binPath, source: 'share-bin-downloaded' };
}

async function installRemoteRg(
  probe: RgProbe,
  environment: Environment,
  binDir: string,
  binPath: string,
  resolveRegion: (() => KimiRegion | undefined) | undefined,
): Promise<void> {
  const host = environment.host;
  if (host === undefined) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      'environment does not provide host information for the ripgrep install',
    );
  }
  const target = detectRemoteTarget(host.osKind, host.osArch);
  if (target === undefined) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      `Unsupported platform/arch for ripgrep download: ${host.osKind}/${host.osArch}`,
      { details: { osKind: host.osKind, osArch: host.osArch } },
    );
  }
  const fs = environment.fs;
  if (fs === undefined) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      'environment does not provide fs for the ripgrep install',
    );
  }
  const binary = await downloadRgBinary(target, resolveRegion);
  await fs.mkdir(binDir, { recursive: true });
  const staged = `${binPath}.download-${randomUUID()}`;
  try {
    await fs.writeBytes(staged, binary);
    if (typeof fs.rename === 'function') {
      await fs.rename(staged, binPath);
    } else {
      await fs.writeBytes(binPath, binary);
      await fs.remove(staged).catch(() => {});
    }
  } finally {
    await fs.remove(staged).catch(() => {});
  }
  if (host.pathClass === 'win32') return;
  await markRemoteRgExecutable(probe, binPath, host.osKind);
}

export async function markRemoteRgExecutable(
  probe: RgProbe,
  binPath: string,
  osKind: string,
): Promise<void> {
  const chmodRun = await probe.exec(['chmod', '755', binPath]).catch(() => ({ exitCode: -1 }));
  if (chmodRun.exitCode === 0) return;
  if (osKind === 'openharmony') {
    const ohosChmodRun = await probe
      .exec(['/system/bin/chmod', '755', binPath])
      .catch(() => ({ exitCode: -1 }));
    if (ohosChmodRun.exitCode === 0) return;
  }
  throw new Error2(
    ErrorCodes.OS_FS_UNAVAILABLE,
    `failed to mark ${binPath} executable on the target`,
  );
}

export async function findExistingRg(
  _probe: RgProbe,
  shareDir: string = getShareDir(),
  allowCachedFallback = true,
): Promise<RgResolution | undefined> {
  const system = await findRgOnPath();
  if (system !== undefined) return { path: system, source: 'system-path' };

  if (allowCachedFallback) {
    const vendorPath = getVendorRgPath(rgBinaryName());
    if (vendorPath !== undefined && (await isExecutableFile(vendorPath))) {
      return { path: vendorPath, source: 'vendor' };
    }
    const cachePath = join(shareDir, 'bin', rgBinaryName());
    if (await isExecutableFile(cachePath)) {
      return { path: cachePath, source: 'share-bin-cached' };
    }
  }

  return undefined;
}

let downloadPromise: Promise<RgResolution> | undefined;
async function downloadRgWithLock(
  probe: RgProbe,
  shareDir: string,
  resolveRegion: (() => KimiRegion | undefined) | undefined,
): Promise<RgResolution> {
  if (downloadPromise !== undefined) return downloadPromise;
  downloadPromise = (async () => {
    try {
      const existing = await findExistingRg(probe, shareDir, true);
      if (existing) return existing;
      const binPath = await downloadAndInstallRg(shareDir, resolveRegion);
      return { path: binPath, source: 'share-bin-downloaded' };
    } finally {
      downloadPromise = undefined;
    }
  })();
  return downloadPromise;
}

function getVendorRgPath(_binName: string): string | undefined {
  return undefined;
}

async function findRgOnPath(): Promise<string | undefined> {
  const pathEnv = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const binName = rgBinaryName();
  for (const dir of pathEnv.split(sep)) {
    if (dir === '') continue;
    const candidate = join(dir, binName);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function detectTarget(): string | undefined {
  const osKind =
    process.platform === 'darwin' ? 'macOS'
      : process.platform === 'linux' ? 'Linux'
        : process.platform === 'win32' ? 'Windows'
          : process.platform;
  return rgTargetFor(osKind, process.arch);
}

export function detectRemoteTarget(osKind: string, osArch: string): string | undefined {
  return rgTargetFor(osKind, osArch);
}

function rgTargetFor(osKind: string, osArch: string): string | undefined {
  const arch = osArch === 'x64' ? 'x86_64' : osArch === 'arm64' ? 'aarch64' : undefined;
  if (arch === undefined) return undefined;
  if (osKind === 'macOS') return `${arch}-apple-darwin`;
  if (osKind === 'Linux') {
    return arch === 'x86_64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-gnu';
  }
  if (osKind === 'Windows') return `${arch}-pc-windows-msvc`;
  if (osKind === 'openharmony') return arch === 'aarch64' ? OHOS_RG_TARGET : undefined;
  return undefined;
}

interface RgArchive {
  readonly archiveName: string;
  readonly expectedSha256: string;
  readonly url: string;
  readonly isWindows: boolean;
  readonly extractedBinaryPath: string;
}

function rgArchiveForTarget(
  target: string,
  resolveRegion: (() => KimiRegion | undefined) | undefined,
): RgArchive {
  const isOhos = target === OHOS_RG_TARGET;
  const isWindows = target.includes('windows');
  const archiveExt = isWindows ? 'zip' : 'tar.gz';
  const version = isOhos ? OHOS_RG_VERSION : RG_VERSION;
  const archiveName = `ripgrep-${version}-${target}.${archiveExt}`;
  const expectedSha256 = RG_ARCHIVE_SHA256[archiveName];
  if (expectedSha256 === undefined) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      `No pinned SHA-256 is configured for ripgrep archive ${archiveName}`,
      { details: { archiveName } },
    );
  }
  const binName = isWindows ? 'rg.exe' : 'rg';
  const extractedBinaryPath = isOhos
    ? join('bin', binName)
    : join(`ripgrep-${version}-${target}`, binName);
  const url = isOhos ? OHOS_RG_ARCHIVE_URL : `${rgBaseUrl(resolveRegion)}/${archiveName}`;
  return { archiveName, expectedSha256, url, isWindows, extractedBinaryPath };
}

async function fetchRgArchive(archive: RgArchive, archivePath: string): Promise<void> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, DOWNLOAD_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(archive.url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!resp.ok || resp.body === null) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      `Failed to download ripgrep: HTTP ${String(resp.status)} ${resp.statusText}`,
      { details: { url: archive.url, status: resp.status, statusText: resp.statusText } },
    );
  }
  const write = createWriteStream(archivePath);
  await pipeline(Readable.fromWeb(resp.body as never), write);
  await verifyArchiveChecksum(archivePath, archive.archiveName, archive.expectedSha256);
}

async function extractRgArchive(archive: RgArchive, archivePath: string, tmp: string): Promise<string> {
  const binName = archive.isWindows ? 'rg.exe' : 'rg';
  if (archive.isWindows) {
    const destination = join(tmp, binName);
    await extractRgFromZip(archivePath, destination);
    return destination;
  }
  return extractRgFromTarGz(archivePath, archive.extractedBinaryPath, join(tmp, 'extract'));
}

export async function extractRgFromTarGz(
  archivePath: string,
  relativeBinaryPath: string,
  extractDir: string,
): Promise<string> {
  const binName = basename(relativeBinaryPath);
  await mkdir(extractDir, { recursive: true });
  await extractTar({
    file: archivePath,
    cwd: extractDir,
    gzip: true,
    filter: (entryPath: string) => entryPath.endsWith(`/${binName}`),
  });
  const extracted = join(extractDir, relativeBinaryPath);
  if (!existsSync(extracted)) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      `Ripgrep archive did not contain expected binary at ${extracted}. ` +
        'CDN content may have changed.',
      { details: { path: extracted } },
    );
  }
  return extracted;
}

async function stageAndInstallRg(
  binDir: string,
  writeStaged: (staged: string) => Promise<void>,
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const destination = join(binDir, rgBinaryName());
  const installDir = await mkdtemp(join(binDir, '.rg-install-'));
  const staged = join(installDir, rgBinaryName());
  try {
    await writeStaged(staged);
    await chmod(staged, 0o755);
    await rename(staged, destination);
  } finally {
    await rm(installDir, { recursive: true, force: true });
  }
  return destination;
}

async function downloadAndInstallRg(
  shareDir: string,
  resolveRegion: (() => KimiRegion | undefined) | undefined,
): Promise<string> {
  const target = detectTarget();
  if (target === undefined) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      `Unsupported platform/arch for ripgrep download: ${process.platform}/${process.arch}`,
      { details: { platform: process.platform, arch: process.arch } },
    );
  }
  const archive = rgArchiveForTarget(target, resolveRegion);

  const binDir = join(shareDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const destination = join(binDir, rgBinaryName());

  const tmp = await mkdtemp(join(tmpdir(), 'kimi-rg-'));
  try {
    const archivePath = join(tmp, archive.archiveName);
    await fetchRgArchive(archive, archivePath);
    const extracted = await extractRgArchive(archive, archivePath, tmp);
    if (archive.isWindows) {
      await copyFile(extracted, destination);
    } else {
      await stageAndInstallRg(binDir, async (staged) => {
        if (target === OHOS_RG_TARGET) {
          await writeFile(staged, selfSignOhosElf(await readFile(extracted)));
        } else {
          await copyFile(extracted, staged);
        }
      });
    }
    return destination;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function downloadRgBinary(
  target: string,
  resolveRegion: (() => KimiRegion | undefined) | undefined,
): Promise<Uint8Array> {
  const archive = rgArchiveForTarget(target, resolveRegion);
  const tmp = await mkdtemp(join(tmpdir(), 'kimi-rg-'));
  try {
    const archivePath = join(tmp, archive.archiveName);
    await fetchRgArchive(archive, archivePath);
    const extracted = await extractRgArchive(archive, archivePath, tmp);
    const bytes = await readFile(extracted);
    return target === OHOS_RG_TARGET ? selfSignOhosElf(bytes) : bytes;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function verifyArchiveChecksum(
  archivePath: string,
  archiveName: string,
  expectedSha256: string,
): Promise<void> {
  const actualSha256 = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error2(
      ErrorCodes.OS_FS_UNAVAILABLE,
      `Ripgrep archive checksum mismatch for ${archiveName}: expected ${expectedSha256}, ` +
        `got ${actualSha256}. CDN content may have changed.`,
      { details: { archiveName, expectedSha256, actualSha256 } },
    );
  }
}

export async function extractRgFromZip(archivePath: string, destination: string): Promise<void> {
  const buf = await readFile(archivePath);
  const binName = 'rg.exe';
  await new Promise<void>((resolve, reject) => {
    yauzlFromBuffer(buf, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr !== null || zipfile === undefined) {
        reject(
          new Error2(
            ErrorCodes.OS_FS_UNAVAILABLE,
            `Failed to open ripgrep archive: ${openErr?.message ?? 'unknown error'}`,
            { cause: openErr ?? undefined },
          ),
        );
        return;
      }
      let found = false;
      const onEntry = (entry: Entry): void => {
        if (basename(entry.fileName) !== binName) {
          zipfile.readEntry();
          return;
        }
        found = true;
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null) {
            reject(
              new Error2(
                ErrorCodes.OS_FS_UNAVAILABLE,
                `Failed to read ${entry.fileName} from archive: ${streamErr.message}`,
                { cause: streamErr },
              ),
            );
            zipfile.close();
            return;
          }
          const out = createWriteStream(destination);
          void (async () => {
            try {
              await pipeline(stream, out);
              zipfile.close();
              resolve();
            } catch (error) {
              zipfile.close();
              reject(
                new Error2(
                  ErrorCodes.OS_FS_UNAVAILABLE,
                  error instanceof Error ? error.message : String(error),
                  { cause: error },
                ),
              );
            }
          })();
        });
      };
      zipfile.on('entry', onEntry);
      zipfile.on('end', () => {
        if (!found) {
          reject(
            new Error2(
              ErrorCodes.OS_FS_UNAVAILABLE,
              `Ripgrep archive did not contain expected binary '${binName}'. ` +
                'CDN content may have changed.',
              { details: { binary: binName } },
            ),
          );
        }
      });
      zipfile.on('error', (err: Error) => {
        reject(err);
      });
      zipfile.readEntry();
    });
  });
}

export function rgUnavailableMessage(cause: unknown, environment?: Environment): string {
  const detail =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
  const isOhos = environment?.host?.osKind === 'openharmony';
  const fixOptions = isOhos
    ? '  OpenHarmony: install the HNP package or download rg from https://atomgit.com/OpenHarmonyPCDeveloper/ohos-ripgrep'
    : `  macOS:   brew install ripgrep\n` +
      `  Ubuntu:  sudo apt-get install ripgrep\n` +
      `  Other:   https://github.com/BurntSushi/ripgrep#installation`;
  const fallback = isOhos
    ? 'Alternatively, drop an OpenHarmony rg binary'
    : 'Alternatively, drop a static rg binary';
  const selfSignNote = isOhos ? ' (unsigned binaries are self-signed automatically)' : '';
  if (isRemoteEnvironment(environment)) {
    const shareBin = shareBinRgPath(environment);
    return (
      `ripgrep (rg) is not available on environment "${environment.identity.environmentId}" and the automatic bootstrap failed.\n` +
      `\n` +
      `Error: ${detail}\n` +
      `\n` +
      `Fix options (install on the target):\n` +
      `${fixOptions}\n` +
      `\n` +
      `${fallback} at ${shareBin} on the target${selfSignNote}`
    );
  }
  const shareBin = getShareBinRgPath();
  return (
    `ripgrep (rg) is not available and the automatic bootstrap failed.\n` +
    `\n` +
    `Error: ${detail}\n` +
    `\n` +
    `Fix options:\n` +
    `${fixOptions}\n` +
    `\n` +
    `${fallback} at ${shareBin}${selfSignNote}`
  );
}
