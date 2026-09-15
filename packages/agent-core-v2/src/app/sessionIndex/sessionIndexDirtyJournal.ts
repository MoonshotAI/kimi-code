import { IFileSystemStorageService } from '#/persistence/interface/storage';

export const SESSION_INDEX_DIRTY_DIR = '.index-dirty';

const EMPTY = new Uint8Array(0);

function dirtyScope(sessionsScope: string): string {
  return `${sessionsScope}/${SESSION_INDEX_DIRTY_DIR}`;
}

export async function markSessionDirty(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  sessionId: string,
): Promise<void> {
  await storage.append(dirtyScope(sessionsScope), `${sessionId}.${Date.now()}`, EMPTY, {
    durable: false,
  });
}

export async function listDirtyMarks(
  storage: IFileSystemStorageService,
  sessionsScope: string,
): Promise<readonly string[]> {
  return storage.list(dirtyScope(sessionsScope));
}

export function dirtyMarkSessionIds(marks: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const name of marks) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) ids.add(name.slice(0, dot));
  }
  return ids;
}

export async function clearDirtyMarks(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  marks: readonly string[],
): Promise<void> {
  await Promise.all(
    marks.map((name) =>
      storage.delete(dirtyScope(sessionsScope), name).catch(() => undefined),
    ),
  );
}
