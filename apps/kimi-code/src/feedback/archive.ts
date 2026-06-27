import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getCacheDir } from '../utils/paths';

const STALE_ARCHIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours.

/**
 * A file produced for a feedback attachment upload. Both the session log
 * archive and the codebase archive share this shape; the generic uploader
 * consumes it without caring how the file was produced.
 */
export interface FeedbackArchive {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly fingerprint: string;
  readonly fileCount: number;
  /** Directory created exclusively for this archive and safe to remove after upload. */
  readonly cleanupDir?: string;
}

export async function createFeedbackArchivePath(filename: string): Promise<{
  readonly archivePath: string;
  readonly cleanupDir: string;
}> {
  const archivePath = await createArchivePath(filename);
  return { archivePath, cleanupDir: archivePathCleanupDir(archivePath) };
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
