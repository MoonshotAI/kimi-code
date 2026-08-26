import type { FileSnapshot } from '#/tool/toolContract';

const MAX_FILE_SNAPSHOT_CHARS = 256 * 1024;

export function buildFileSnapshot(path: string, before: string | null, after: string): FileSnapshot {
  const size = (before?.length ?? 0) + after.length;
  if (size > MAX_FILE_SNAPSHOT_CHARS) {
    return { path, truncated: true };
  }
  return { path, before, after };
}
