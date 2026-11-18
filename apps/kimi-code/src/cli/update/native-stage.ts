import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

import { valid } from 'semver';
import { z } from 'zod';

import { KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME } from '#/constant/app';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';
import { writeJsonFile } from '#/utils/persistence';

import {
  fetchNativeReleaseManifest,
  nativeBinaryUrl,
  selectPlatformEntry,
} from './native-manifest';
import { UPDATE_CHANNELS, type InstallIntent, type UpdateChannel } from './types';

const StagedNativeUpdateSchema = z
  .object({
    version: z.string().min(1),
    target: z.string().min(1),
    exeFileName: z
      .string()
      .min(1)
      .refine((value) => basename(value) === value, { error: 'must be a plain file name' }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    exeSize: z.number().int().min(1),
    stagedAt: z.string().min(1),
    channel: z.enum(UPDATE_CHANNELS),
    manual: z.boolean().optional(),
    intent: z.literal('switch-channel').optional(),
  })
  .strict()
  .refine((value) => value.intent !== 'switch-channel' || value.manual === true, {
    error: 'switch-channel stages must be manual',
  });

export type StagedNativeUpdate = z.infer<typeof StagedNativeUpdateSchema>;

export function matchesStagedUpdateRequest(
  staged: StagedNativeUpdate,
  request: {
    readonly version: string;
    readonly channel: UpdateChannel;
    readonly manual?: boolean;
    readonly intent?: InstallIntent;
  },
): boolean {
  if (staged.version !== request.version || staged.channel !== request.channel) return false;
  if (request.intent !== 'switch-channel') return true;
  return request.manual === true && staged.manual === true && staged.intent === 'switch-channel';
}

export function stagedExeFileName(version: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `kimi-${version}.exe` : `kimi-${version}`;
}

let stageTempCounter = 0;

function uniqueStagedExeFileName(version: string, platform: NodeJS.Platform): string {
  const infix = `.${process.pid}.${Date.now()}.${stageTempCounter}`;
  stageTempCounter += 1;
  return platform === 'win32' ? `kimi-${version}${infix}.exe` : `kimi-${version}${infix}`;
}

export function stagedExePath(exePath: string, staged: StagedNativeUpdate): string {
  return join(getNativeStagingDir(exePath), staged.exeFileName);
}

export function parseStagedNativeUpdate(raw: string): StagedNativeUpdate | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StagedNativeUpdateSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function readStagedNativeUpdate(
  exePath: string,
  filePath: string = getNativeStagedStateFile(exePath),
): Promise<StagedNativeUpdate | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  const staged = parseStagedNativeUpdate(raw);
  if (staged === null) return null;
  const info = await stat(stagedExePath(exePath, staged)).catch(() => null);
  if (info === null || info.size !== staged.exeSize) return null;
  return staged;
}

function isSameStagedRecord(a: StagedNativeUpdate, b: StagedNativeUpdate): boolean {
  return (
    a.version === b.version &&
    a.target === b.target &&
    a.exeFileName === b.exeFileName &&
    a.sha256 === b.sha256 &&
    a.exeSize === b.exeSize &&
    a.stagedAt === b.stagedAt &&
    a.channel === b.channel &&
    a.intent === b.intent
  );
}

export async function promoteStagedUpdateToManual(
  exePath: string,
  expected: StagedNativeUpdate,
): Promise<boolean> {
  if (expected.manual === true) return true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const staged = await readStagedNativeUpdate(exePath);
    if (staged === null || !isSameStagedRecord(staged, expected)) return false;
    if (staged.manual === true) return true;
    await writeJsonFile(getNativeStagedStateFile(exePath), StagedNativeUpdateSchema, {
      ...staged,
      manual: true,
    });
    const confirmed = await readStagedNativeUpdate(exePath);
    if (confirmed?.manual === true && isSameStagedRecord(confirmed, expected)) return true;
  }
  return false;
}

export async function hashFileSha256(filePath: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function isUpdaterOwnedStagingFile(entry: string): boolean {
  if (!entry.startsWith('kimi-')) return false;
  let name = entry.slice('kimi-'.length);
  if (name.endsWith('.part')) name = name.slice(0, -'.part'.length);
  if (name.endsWith('.zst')) name = name.slice(0, -'.zst'.length);
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  const candidates = [
    name,
    name.replace(/\.\d+\.\d+$/, ''),
    name.replace(/\.\d+\.\d+\.\d+$/, ''),
  ];
  return candidates.some((candidate) => valid(candidate) !== null);
}

const STAGING_ORPHAN_GRACE_MS = 60 * 60 * 1000;

async function cleanupStagingOrphans(stagingDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch {
    return;
  }
  const keep = new Set<string>([KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME]);
  for (const entry of entries) {
    if (
      entry !== KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME &&
      !entry.startsWith(`${KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME}.swap-`)
    ) {
      continue;
    }
    keep.add(entry);
    const raw = await readFile(join(stagingDir, entry), 'utf-8').catch(() => null);
    if (raw === null) continue;
    try {
      const exeFileName: unknown = (JSON.parse(raw) as { exeFileName?: unknown }).exeFileName;
      if (typeof exeFileName === 'string' && exeFileName.length > 0) {
        keep.add(basename(exeFileName));
      }
    } catch {}
  }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    if (!isUpdaterOwnedStagingFile(entry)) continue;
    const full = join(stagingDir, entry);
    const info = await stat(full).catch(() => null);
    if (info === null) continue;
    if (Date.now() - info.mtimeMs < STAGING_ORPHAN_GRACE_MS) continue;
    await unlink(full).catch(() => {});
  }
}

export interface StageNativeUpdateOptions {
  readonly version: string;
  readonly channel?: UpdateChannel;
  readonly exePath: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
  readonly idleTimeoutMs?: number;
  readonly manual?: boolean;
  readonly intent?: InstallIntent;
}

export type StageNativeUpdateStatus = 'already-staged' | 'staged';

export interface StageNativeUpdateResult {
  readonly status: StageNativeUpdateStatus;
  readonly staged: StagedNativeUpdate;
}

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

async function downloadAndHash(
  url: string,
  partPath: string,
  expectedSha256: string,
  fetchImpl: typeof fetch,
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
  idleTimeoutMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<number> {
  const controller = new AbortController();
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimeout = (): void => {
    if (idleTimeout !== undefined) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      controller.abort(new Error(`download stalled: no data for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  };
  armIdleTimeout();
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    clearTimeout(idleTimeout);
    throw error;
  }
  if (!response.ok || response.body === null) {
    clearTimeout(idleTimeout);
    throw new Error(`native binary download returned HTTP ${response.status}`);
  }
  const contentLength = response.headers.get('content-length');
  const total =
    contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
  const hash = createHash('sha256');
  let size = 0;
  const file = await open(partPath, 'w');
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      armIdleTimeout();
      hash.update(chunk);
      size += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset);
        if (bytesWritten === 0) {
          throw new Error('failed to write the native binary to disk (disk full?)');
        }
        offset += bytesWritten;
      }
      onProgress?.(size, total);
    }
  } finally {
    clearTimeout(idleTimeout);
    await file.close();
  }
  const digest = hash.digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${digest}`);
  }
  return size;
}

async function decompressAndHash(
  zstPath: string,
  destPath: string,
  expectedSha256: string,
): Promise<number> {
  const hash = createHash('sha256');
  let size = 0;
  const file = await open(destPath, 'w');
  try {
    for await (const chunk of createReadStream(zstPath).pipe(createZstdDecompress())) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
      let offset = 0;
      while (offset < (chunk as Buffer).length) {
        const { bytesWritten } = await file.write(chunk as Buffer, offset);
        if (bytesWritten === 0) {
          throw new Error('failed to write the native binary to disk (disk full?)');
        }
        offset += bytesWritten;
      }
    }
  } finally {
    await file.close();
  }
  const digest = hash.digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${digest}`);
  }
  return size;
}

export async function stageNativeUpdate(
  options: StageNativeUpdateOptions,
): Promise<StageNativeUpdateResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (options.intent === 'switch-channel' && options.manual !== true) {
    throw new Error('channel switch staging requires manual confirmation');
  }
  const channel = options.channel ?? 'stable';
  if (valid(options.version) === null) {
    throw new Error(`invalid semver for native staging: ${JSON.stringify(options.version)}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = `${platform}-${arch}`;
  const exeFileName = uniqueStagedExeFileName(options.version, platform);

  const existing = await readStagedNativeUpdate(options.exePath);
  if (
    existing !== null &&
    matchesStagedUpdateRequest(existing, {
      version: options.version,
      channel,
      manual: options.manual,
      intent: options.intent,
    })
  ) {
    const digest = await hashFileSha256(stagedExePath(options.exePath, existing));
    if (digest === existing.sha256) {
      if (options.manual === true && existing.manual !== true) {
        if (await promoteStagedUpdateToManual(options.exePath, existing)) {
          return { status: 'already-staged', staged: { ...existing, manual: true } };
        }
      } else {
        return { status: 'already-staged', staged: existing };
      }
    }
  }

  const stagingDir = getNativeStagingDir(options.exePath);
  await mkdir(stagingDir, { recursive: true });
  await cleanupStagingOrphans(stagingDir);

  const staged: StagedNativeUpdate = {
    version: options.version,
    target,
    exeFileName,
    sha256: '',
    exeSize: 0,
    stagedAt: new Date().toISOString(),
    channel,
    manual: options.manual === true ? true : undefined,
    intent: options.intent === 'switch-channel' ? 'switch-channel' : undefined,
  };

  const partPath = join(stagingDir, `${exeFileName}.part`);
  try {
    const manifest = await fetchNativeReleaseManifest(options.version, fetchImpl);
    const entry = selectPlatformEntry(manifest, platform, arch);
    const compressed = entry.zstd === undefined
      ? entry.compressed
      : { filename: entry.zstd.file, checksum: entry.zstd.sha256 };
    let size: number | undefined;
    if (compressed !== undefined && typeof createZstdDecompress === 'function') {
      const zstPartPath = join(stagingDir, `${exeFileName}.zst.part`);
      try {
        await downloadAndHash(
          nativeBinaryUrl(options.version, compressed.filename),
          zstPartPath,
          compressed.checksum,
          fetchImpl,
          options.onProgress,
          options.idleTimeoutMs,
        );
        size = await decompressAndHash(zstPartPath, partPath, entry.checksum);
        await rm(zstPartPath, { force: true });
      } catch (error) {
        console.warn(
          `[update] compressed artifact unavailable, falling back to uncompressed download: ${error instanceof Error ? error.message : String(error)}`,
        );
        await rm(zstPartPath, { force: true }).catch(() => {});
        await rm(partPath, { force: true }).catch(() => {});
      }
    }
    size ??= await downloadAndHash(
      nativeBinaryUrl(options.version, entry.filename),
      partPath,
      entry.checksum,
      fetchImpl,
      options.onProgress,
      options.idleTimeoutMs,
    );
    await chmod(partPath, 0o755);
    await rename(partPath, stagedExePath(options.exePath, staged));

    staged.sha256 = entry.checksum;
    staged.exeSize = size;
    await writeJsonFile(
      getNativeStagedStateFile(options.exePath),
      StagedNativeUpdateSchema,
      staged,
    );
    return { status: 'staged', staged };
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => {});
    await rmdir(getNativeStagingDir(options.exePath)).catch(() => {});
    throw error;
  }
}
