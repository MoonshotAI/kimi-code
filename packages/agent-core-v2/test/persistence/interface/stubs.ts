/**
 * `persistence` test stubs — minimal no-op `IQueryStore` for unit tests.
 *
 * Lives under `test/` (not `src/`). Import from a relative path.
 */

import {
  IQueryStore,
  type Checkpoint,
  type IQuery,
  type Page,
} from '#/persistence/interface/queryStore';

export function stubQueryStore(): IQueryStore {
  return {
    _serviceBrand: undefined,
    put: async (_c: string, _k: string, _v: unknown) => {},
    batch: async (_ops) => {},
    delete: async (_c: string, _k: string) => {},
    get: async <T>(_c: string, _k: string) => undefined as T | undefined,
    query: <T>(_c: string) => emptyQuery<T>(),
    ensureIndex: async (_c, _d) => {},
    getCheckpoint: async (_s: string) => undefined as Checkpoint | undefined,
    setCheckpoint: async (_s: string, _c: Checkpoint) => {},
    close: async () => {},
  };
}

function emptyQuery<T>(): IQuery<T> {
  const page: Page<T> = { items: [] };
  const q: IQuery<T> = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    cursor: () => q,
    execute: () => Promise.resolve(page),
  };
  return q;
}
