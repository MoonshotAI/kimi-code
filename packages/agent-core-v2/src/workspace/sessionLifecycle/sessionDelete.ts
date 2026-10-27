
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { ISessionManager } from '#/app/sessionManager/sessionManager';

export type SessionDeleteBatchItemOutcome =
  | { id: string; ok: true }
  | { id: string; ok: false; error: unknown };

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
      return { id, ok: false, error };
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
