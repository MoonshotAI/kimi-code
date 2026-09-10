
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { getLiveSessionById } from '#/app/sessionManager/sessionLookup';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { normalizeSessionMeta, encodeSessionMeta } from '#/session/sessionMetadata/sessionMetadataService';

import { sessionScopeOf, legacySessionMetaScopeOf, workspacePersistenceScope } from './internal/addressing';
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
  let raw = await docs.get<SessionMeta>(metaScope, 'state.json');
  let legacyMetaScope: string | undefined;
  if (raw === undefined) {
    legacyMetaScope = legacySessionMetaScopeOf(metaScope);
    raw = await docs.get<SessionMeta>(legacyMetaScope, 'state.json');
  }
  if (raw === undefined) return 'not_found';
  const persisted = normalizeSessionMeta(raw, sessionId);
  const archivedAt = archived ? Date.now() : undefined;
  const nextMeta: SessionMeta = { ...persisted, archived, archivedAt };
  await docs.set(metaScope, 'state.json', encodeSessionMeta(nextMeta));
  if (legacyMetaScope !== undefined) await docs.delete(legacyMetaScope, 'state.json');
  accessor.get(ISessionIndexMirror).record(
    buildSessionSummary({
      id: sessionId,
      workspaceId: summary.workspaceId,
      cwd: nextMeta.cwd ?? summary.cwd,
      title: nextMeta.title,
      lastPrompt: nextMeta.lastPrompt,
      createdAt: nextMeta.createdAt,
      updatedAt: nextMeta.updatedAt,
      archived,
      archivedAt,
      custom: nextMeta.custom,
      lastTurnReason: nextMeta.lastTurnReason,
    }),
  );
  if (archived) {
    accessor
      .get(IEventService)
      .publish(new SessionArchived({ payload: { sessionId, workspaceId: summary.workspaceId } }));
  }
  return 'updated';
}

export async function setSessionArchived(
  accessor: ServicesAccessor,
  sessionId: string,
  archived: boolean,
): Promise<ColdSessionArchiveOutcome> {
  const manager = accessor.get(ISessionManager);
  return manager.withLifecycleSerialization(sessionId, async (unguarded) => {
    await manager.whenResumeSettled(sessionId).catch(() => undefined);
    const live = getLiveSessionById(accessor, sessionId);
    if (live !== undefined) {
      if (archived) await unguarded.archive();
      else await unguarded.restore();
      return 'updated';
    }
    return setColdSessionArchived(accessor, sessionId, archived);
  });
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
      const outcome = await setSessionArchived(accessor, id, archived);
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
