/**
 * `sessionLifecycle` domain — cold-session archive/restore without session
 * materialization, plus the live/cold batch orchestration built on top of it.
 *
 * `setSessionArchivedBatch` answers a batch of ids in input order: each
 * id's classify + mutate runs inside `sessionManager`'s per-session
 * lifecycle serialization (every lifecycle transition queues on the same
 * chain; the section's own archive/restore ride the unguarded view), so
 * no resume can materialize stale state over a cold write and no close
 * can slip between the live check and the archive call. Live sessions
 * go through the full `sessionManager` lifecycle chain (never resumed),
 * and cold sessions are patched straight into the persisted metadata
 * document through `persistence` (existence reads from `sessionIndex`,
 * with the pre-unification `session-meta/` fallback, migrating the
 * document to the canonical location), normalized and encoded through
 * the metadata service's own paths so v1 readers stay compatible,
 * mirrored into the `sessionIndex` read model from the authoritative
 * persisted meta (never the possibly-stale index summary), and announced
 * through `event` — never materialized; storage/decode failures
 * propagate as per-item errors, never as not_found. Plain functions over
 * a STABLE accessor; own no scoped state.
 */

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
      return await manager.withLifecycleSerialization(id, async (unguarded) => {
        await manager.whenResumeSettled(id);
        const live = getLiveSessionById(accessor, id);
        if (live !== undefined) {
          // The section holds the chain — the lifecycle calls go through the
          // unguarded view so they can't self-deadlock it.
          if (archived) await unguarded.archive();
          else await unguarded.restore();
          return { id, ok: true };
        }
        const outcome = await setColdSessionArchived(accessor, id, archived);
        return outcome === 'updated'
          ? { id, ok: true }
          : { id, ok: false, reason: 'not_found', message: `session ${id} does not exist` };
      });
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
