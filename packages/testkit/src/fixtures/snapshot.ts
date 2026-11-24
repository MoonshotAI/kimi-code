import { createHash } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type DirectorySnapshot = Readonly<Record<string, string>>;

export interface DirectoryChange {
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'changed';
}

export function contentDigest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function snapshotDirectory(root: string): Promise<DirectorySnapshot> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const digests = await Promise.all(
    entries.map(async (entry): Promise<[string, string] | undefined> => {
      const path = join(entry.parentPath, entry.name);
      const key = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) return [key, `link:${await readlink(path)}`];
      if (entry.isFile()) return [key, contentDigest(await readFile(path))];
      return undefined;
    }),
  );
  return Object.fromEntries(digests.filter((digest) => digest !== undefined).toSorted(([left], [right]) => left.localeCompare(right)));
}

export function directoryChanges(before: DirectorySnapshot, after: DirectorySnapshot): DirectoryChange[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  return paths.flatMap((path): DirectoryChange[] => {
    const earlier = Object.hasOwn(before, path) ? before[path] : undefined;
    const later = Object.hasOwn(after, path) ? after[path] : undefined;
    if (earlier === later) return [];
    if (earlier === undefined) return [{ path, kind: 'added' }];
    if (later === undefined) return [{ path, kind: 'removed' }];
    return [{ path, kind: 'changed' }];
  });
}
