/**
 * `sessionLifecycle` domain — cold-session archive/restore without session
 * materialization, plus the live/cold batch orchestration built on top of it.
 *
 * `setSessionArchivedBatch` answers a batch of ids in input order: live
 * sessions through the full lifecycle chain (never resumed), cold sessions
 * through the direct write below (never materialized), failures folded
 * per item.
 *
 * The direct write puts the archived flag straight into the persisted metadata document
 * (`state.json` under the handler-chain scope derived through
 * `internal/addressing` from the `bootstrap` sessions scope) via the
 * `storage` access-pattern store, mirrors the flipped summary into the
 * `sessionIndex` mirror queue (drained by the caller, never per item), and
 * publishes the same `event.session.archived` bus event the live
 * `ISessionLifecycleService.archive` emits through `event` — restore
 * publishes nothing, matching the live `restore` (which only flips the
 * flag through `ISessionMetadata`). `updatedAt` is preserved verbatim,
 * mirroring `setArchived`'s `touchUpdatedAt: false` semantics, and every
 * other persisted field survives the read-modify-write untouched. Call
 * only for a session with no live handle in any workspace handler — a
 * live session must go through the full lifecycle so its agents drain
 * and its scope tears down; the direct write deliberately races a
 * concurrent resume unsynchronized (the read model heals by
 * reconciliation). Existence reads from `ISessionIndex`: an unknown id
 * and an index entry whose document is unreadable both report
 * `not_found`.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { liveHandlerForSession } from '#/app/workspaceLifecycle/sessionLookup';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';

import { sessionScopeOf, workspacePersistenceScope } from './internal/addressing';

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
    accessor
      .get(IEventService)
      .publish({ type: 'event.session.archived', payload: { sessionId } });
  }
  return 'updated';
}

export type SessionArchiveBatchItemOutcome =
  | { id: string; ok: true }
  | { id: string; ok: false; reason: 'not_found' | 'error'; message: string };

/**
 * Batch archive/restore with the live/cold split: a session with a live
 * handle goes through the full `ISessionLifecycleService` chain (workspace
 * handler accessor — the canonical owner, same path as the v1 action
 * route), everything else through the direct cold patch above (never
 * materialized). Per-item failures fold into the outcome list in input
 * order — the batch itself never throws for item work. Live items run with
 * bounded concurrency; mirror records queue and are drained by the CALLER
 * (one drain for the whole batch).
 */
export async function setSessionArchivedBatch(
  accessor: ServicesAccessor,
  ids: readonly string[],
  archived: boolean,
): Promise<SessionArchiveBatchItemOutcome[]> {
  const outcomes: (SessionArchiveBatchItemOutcome | undefined)[] = ids.map(() => undefined);
  const applyOne = async (id: string): Promise<SessionArchiveBatchItemOutcome> => {
    try {
      const liveHandler = liveHandlerForSession(accessor, id);
      if (liveHandler !== undefined) {
        const lifecycle = liveHandler.accessor.get(ISessionLifecycleService);
        if (archived) await lifecycle.archive(id);
        else await lifecycle.restore(id);
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
  // Every slot was assigned by the workers — no undefined entries remain.
  return outcomes as SessionArchiveBatchItemOutcome[];
}
