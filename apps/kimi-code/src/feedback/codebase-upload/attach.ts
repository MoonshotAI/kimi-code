import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { getCacheDir } from '../../utils/paths';
import { packageCodebase, packageSessionFiles } from './packager';
import type {
  CompletedUploadPart,
  FeedbackCodebaseArchive,
  FeedbackCodebaseScanResult,
  FeedbackUploadPart,
  FeedbackUploadUrlApi,
} from './types';

export const CODEBASE_ARCHIVE_FILENAME = 'repo.zip';
export const SESSION_ARCHIVE_FILENAME = 'session.zip';

const MAX_ARCHIVE_SIZE = 524_288_000; // 500 MiB, matches the backend limit.
const STALE_ARCHIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours.
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_PART_TIMEOUT_MS = 60_000;
const RETRY_BASE_DELAY_MS = 1_000;

export async function packageCurrentCodebase(
  scan: FeedbackCodebaseScanResult,
): Promise<FeedbackCodebaseArchive> {
  const archivePath = await createArchivePath(CODEBASE_ARCHIVE_FILENAME);
  const archive = await packageCodebase(scan, archivePath);
  return { ...archive, cleanupDir: archivePathCleanupDir(archivePath) };
}

export async function packageCurrentSession(sessionDir: string): Promise<FeedbackCodebaseArchive> {
  const archivePath = await createArchivePath(SESSION_ARCHIVE_FILENAME);
  const archive = await packageSessionFiles(sessionDir, archivePath);
  return { ...archive, cleanupDir: archivePathCleanupDir(archivePath) };
}

export async function removePackagedCodebaseArchive(archive: FeedbackCodebaseArchive): Promise<void> {
  if (archive.cleanupDir !== undefined) {
    await rm(archive.cleanupDir, { recursive: true, force: true });
    return;
  }
  await rm(archive.path, { force: true });
}

export interface UploadPackagedCodebaseOptions {
  /** Zip entry name sent to the backend (defaults to `repo.zip`). */
  readonly filename?: string;
  /** Abort a single part PUT if it does not complete within this many milliseconds. */
  readonly timeoutMs?: number;
  /** Number of parts to upload concurrently (defaults to 3). */
  readonly concurrency?: number;
  /** Per-part retry attempts after the first failure (defaults to 3). */
  readonly maxRetries?: number;
  /** Called after each part finishes with the cumulative uploaded bytes. */
  readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export async function uploadPackagedCodebase(
  api: FeedbackUploadUrlApi,
  archive: FeedbackCodebaseArchive,
  feedbackId: number,
  options: UploadPackagedCodebaseOptions = {},
): Promise<void> {
  if (archive.size > MAX_ARCHIVE_SIZE) {
    throw new Error(
      `Failed to upload codebase archive: size ${archive.size} exceeds maximum allowed size ${MAX_ARCHIVE_SIZE}.`,
    );
  }
  const created = await api.createUploadUrl({
    feedbackId,
    filename: options.filename ?? CODEBASE_ARCHIVE_FILENAME,
    size: archive.size,
    sha256: archive.sha256,
  });
  const completed = await uploadParts(archive.path, created.parts, archive.size, options);
  await api.completeUpload({ uploadId: created.uploadId, parts: completed });
}

interface PartLayout {
  readonly part: FeedbackUploadPart;
  readonly start: number;
}

function layoutParts(parts: readonly FeedbackUploadPart[]): PartLayout[] {
  const sorted = parts.toSorted((a, b) => a.partNumber - b.partNumber);
  let offset = 0;
  return sorted.map((part) => {
    const start = offset;
    offset += part.size;
    return { part, start };
  });
}

async function uploadParts(
  filePath: string,
  parts: readonly FeedbackUploadPart[],
  totalBytes: number,
  options: UploadPackagedCodebaseOptions,
): Promise<CompletedUploadPart[]> {
  const layout = layoutParts(parts);
  const results: CompletedUploadPart[] = Array.from({ length: layout.length });
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, layout.length));
  let nextIndex = 0;
  let uploadedBytes = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= layout.length) return;
      const entry = layout[index];
      if (entry === undefined) return;
      const completed = await uploadOnePartWithRetry(filePath, entry, options);
      results[index] = completed;
      uploadedBytes += entry.part.size;
      options.onProgress?.(uploadedBytes, totalBytes);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function uploadOnePartWithRetry(
  filePath: string,
  layout: PartLayout,
  options: UploadPackagedCodebaseOptions,
): Promise<CompletedUploadPart> {
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await uploadOnePart(filePath, layout, options);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !isRetryable(error)) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

async function uploadOnePart(
  filePath: string,
  layout: PartLayout,
  options: UploadPackagedCodebaseOptions,
): Promise<CompletedUploadPart> {
  const { part, start } = layout;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PART_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const stream = createReadStream(filePath, { start, end: start + part.size - 1 });
  try {
    const res = await fetch(part.url, {
      method: part.method,
      body: Readable.toWeb(stream),
      headers: { 'Content-Length': String(part.size) },
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new UploadPartHttpError(part.partNumber, res.status, text);
    }
    const etag = res.headers.get('etag');
    if (etag === null || etag.length === 0) {
      throw new Error(`Failed to upload part ${part.partNumber}: missing ETag in response.`);
    }
    return { partNumber: part.partNumber, etag };
  } catch (error) {
    stream.destroy();
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Failed to upload part ${part.partNumber}: upload timed out.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class UploadPartHttpError extends Error {
  constructor(
    readonly partNumber: number,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(
      `Failed to upload part ${partNumber}: HTTP ${String(status)}${responseBody.length > 0 ? ` ${responseBody}` : ''}`,
    );
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof UploadPartHttpError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  // Network errors and timeouts are retryable.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Remove feedback-upload archive directories older than 24 hours. Packaging
 * cleans up its own archive on success and on failure, but a killed process
 * or an empty parent dir can still leave leftovers behind; this is a
 * best-effort backstop so the cache dir does not grow without bound.
 *
 * `dir` is injectable for tests; production callers leave it as the default.
 */
export async function removeStaleFeedbackUploads(
  options: { readonly now?: number; readonly dir?: string } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const dir = options.dir ?? join(getCacheDir(), 'feedback-uploads');
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (entries === null) return;

  const cutoff = now - STALE_ARCHIVE_MAX_AGE_MS;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
      const target = join(dir, entry.name);
      const targetStat = await stat(target).catch(() => null);
      if (targetStat === null || targetStat.mtimeMs >= cutoff) return;
      await rm(target, { recursive: true, force: true }).catch(() => {});
    }),
  );
}

async function createArchivePath(filename: string): Promise<string> {
  await removeStaleFeedbackUploads();
  const root = join(getCacheDir(), 'feedback-uploads');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'upload-'));
  return join(dir, filename);
}

function archivePathCleanupDir(archivePath: string): string {
  return dirname(archivePath);
}
