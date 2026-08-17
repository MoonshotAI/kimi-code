/**
 * `sessionLifecycle` domain — cold-session archive/restore without session
 * materialization, plus the live/cold batch orchestration built on top of it.
 *
 * `setSessionArchivedBatch` answers a batch of ids in input order: an
 * in-flight resume is settled through `sessionManager` before classifying
 * (the live registry hides the handle while one runs), live sessions go
 * through the full `sessionManager` lifecycle chain (never resumed), and
 * cold sessions are patched straight into the persisted metadata document
 * through `persistence` (existence reads from `sessionIndex`), mirrored
 * into the `sessionIndex` read model, and announced through `event` —
 * never materialized. Plain functions over a STABLE accessor; own no
 * scoped state.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { getLiveSessionById } from '#/app/sessionManager/sessionLookup';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import { sessionScopeOf, workspacePersistenceScope } from './internal/addressing';
import { SessionArchived } from './sessionLifecycleEvents';

export type ColdSessionArchiveOutcome = 'updated' | 'not_found';

export async function setColdSessionArchived(
  accessor: ServicesAccessor,
  sessionId: string,
  archived: boolean,
): Promise<ColdSessionArchiveOutcome> {
  const summary = await accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return 'not_found';
  const docs = accessor.get(IAtomicDocumentStore);
  const metaScope = sessionScopeOf(
    workspacePersistenceScope(
      accessor.get(IBootstrapService).scope('sessions'),
      summary.workspaceId,
    ),
    sessionId,
  );
  let persisted: SessionMeta | undefined;
  try {
    persisted = await docs.get<SessionMeta>(metaScope, 'state.json');
  } catch {
    persisted = undefined;
  }
  if (persisted === undefined) return 'not_found';
  const archivedAt = archived ? Date.now() : undefined;
  await docs.set(metaScope, 'state.json', { ...persisted, archived, archivedAt });
  accessor.get(ISessionIndexMirror).record({ ...summary, archived, archivedAt });
  if (archived) {
    accessor.get(IEventService).publish(new SessionArchived({ payload: { sessionId } }));
  }
  return 'updated';
}

export type SessionArchiveBatchItemOutcome =
  | { id: string; ok: true }
  | { id: string; ok: false; reason: 'not_found' | 'error'; message: string };

export async function setSessionArchivedBatch(
  accessor: ServicesAccessor,
  ids: readonly string[],
  archived: boolean,
): Promise<SessionArchiveBatchItemOutcome[]> {
  const outcomes: (SessionArchiveBatchItemOutcome | undefined)[] = ids.map(() => undefined);
  const applyOne = async (id: string): Promise<SessionArchiveBatchItemOutcome> => {
    try {
      const manager = accessor.get(ISessionManager);
      await manager.whenResumeSettled(id);
      if (getLiveSessionById(accessor, id) !== undefined) {
        if (archived) await manager.archive(id);
        else await manager.restore(id);
        return { id, ok: true };
      }
      const outcome = await setColdSessionArchived(accessor, id, archived);
      return outcome === 'updated'
        ? { id, ok: true }
        : { id, ok: false, reason: 'not_found', message: `session ${id} does not exist` };
    } catch (error) {
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
  return outcomes as SessionArchiveBatchItemOutcome[];
}
