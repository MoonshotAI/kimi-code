import {
  SessionSpaceError,
  type SessionRecord,
  type SessionSpace,
  type SessionSpaceBackend,
} from './model';

function invalidKey(key: string): SessionSpaceError {
  return new SessionSpaceError('invalid-key', `invalid session key '${key}'`);
}

function assertKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw invalidKey(key);
  }
}

function assertPrefix(prefix: string | undefined): void {
  if (prefix === undefined || prefix === '') return;
  if (
    prefix.startsWith('/') ||
    prefix.includes('\\') ||
    prefix.includes('\0') ||
    prefix.split('/').some((part) => part === '..')
  ) {
    throw invalidKey(prefix);
  }
}

export function createSessionSpace<T extends SessionRecord>(
  backend: SessionSpaceBackend<T>,
  now: () => number = Date.now,
): SessionSpace<T> {
  const read = async (key: string): Promise<T | undefined> => {
    assertKey(key);
    return backend.read(key);
  };

  return {
    list: async (prefix) => {
      assertPrefix(prefix);
      const keys = await backend.list(prefix);
      return keys
        .filter((key) => prefix === undefined || key.startsWith(prefix))
        .toSorted();
    },
    get: read,
    create: async (key, init) => {
      assertKey(key);
      if ((await backend.read(key)) !== undefined) {
        throw new SessionSpaceError('already-exists', `session '${key}' already exists`);
      }
      const time = now();
      const record = {
        ...init,
        createdAt: init.createdAt ?? time,
        updatedAt: init.updatedAt ?? time,
      } as T;
      await backend.write(key, record);
      return record;
    },
    update: async (key, patch, opts) => {
      const current = await read(key);
      if (current === undefined) {
        throw new SessionSpaceError('not-found', `session '${key}' does not exist`);
      }
      const updatedAt =
        patch.updatedAt ?? (opts?.touchUpdatedAt === false ? current.updatedAt : now());
      const record = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt,
      };
      await backend.write(key, record);
      return record;
    },
    delete: async (key) => {
      assertKey(key);
      if (!(await backend.delete(key))) {
        throw new SessionSpaceError('not-found', `session '${key}' does not exist`);
      }
    },
  };
}
