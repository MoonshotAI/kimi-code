
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ErrorCodes, isError2 } from '#/errors';

export type SessionDeleteBatchItemOutcome =
  | { id: string; ok: true }
  | { id: string; ok: false; reason: 'not_found' | 'error'; message: string };

export async function deleteSessionsBatch(
  accessor: ServicesAccessor,
  ids: readonly string[],
): Promise<SessionDeleteBatchItemOutcome[]> {
  const outcomes: (SessionDeleteBatchItemOutcome | undefined)[] = ids.map(() => undefined);
  const applyOne = async (id: string): Promise<SessionDeleteBatchItemOutcome> => {
    try {
      await accessor.get(ISessionManager).delete(id);
      return { id, ok: true };
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.SESSION_NOT_FOUND) {
        return { id, ok: false, reason: 'not_found', message: error.message };
      }
      return {
        id,
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const BATCH_CONCURRENCY = 8;
  let next = 0;
  const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      outcomes[index] = await applyOne(ids[index] as string);
    }
  });
  await Promise.all(workers);
  return outcomes as SessionDeleteBatchItemOutcome[];
}
