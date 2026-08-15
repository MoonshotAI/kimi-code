/**
 * `sessionLifecycle` domain — cold-session archive/restore without session
 * materialization.
 *
 * Writes the archived flag straight into the persisted metadata document
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
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

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
