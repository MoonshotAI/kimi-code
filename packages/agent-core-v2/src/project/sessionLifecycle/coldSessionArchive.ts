
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { getLiveSessionById } from '#/app/sessionManager/sessionLookup';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import { withColdSessionMeta } from './internal/coldSessionMeta';
import { SessionArchived, SessionRestored } from './sessionLifecycleEvents';

export type ColdSessionArchiveOutcome = 'updated' | 'not_found';

export async function setColdSessionArchived(
  accessor: ServicesAccessor,
  sessionId: string,
  archived: boolean,
): Promise<ColdSessionArchiveOutcome> {
  const outcome = await withColdSessionMeta(accessor, sessionId, async ({ summary, persisted, write }) => {
    const archivedAt = archived ? Date.now() : undefined;
    const nextMeta: SessionMeta = { ...persisted, archived, archivedAt };
    await write(nextMeta);
    const payload = { sessionId, workspaceId: summary.workspaceId };
    if (archived) {
      accessor.get(IEventService).publish(new SessionArchived({ payload }));
    } else if (persisted.archived) {
      accessor.get(IEventService).publish(new SessionRestored({ payload }));
    }
    return 'updated' as const;
  });
  return outcome ?? 'not_found';
}

export async function setSessionArchived(
  accessor: ServicesAccessor,
  sessionId: string,
  archived: boolean,
): Promise<ColdSessionArchiveOutcome> {
  const manager = accessor.get(ISessionManager);
  await manager.whenResumeSettled(sessionId).catch(() => undefined);
  return manager.withLifecycleSerialization(sessionId, async (unguarded) => {
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
