import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProjectService } from '#/app/project/project';
import { ISessionIndex, ISessionIndexMirror, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { normalizeSessionMeta, encodeSessionMeta } from '#/session/sessionMetadata/sessionMetadataService';

import { sessionScopeOf, legacySessionMetaScopeOf, projectPersistenceScope } from './addressing';

export interface ColdSessionMeta {
  readonly summary: SessionSummary;
  readonly persisted: SessionMeta;
  readonly write: (next: SessionMeta) => Promise<void>;
}

export async function withColdSessionMeta<T>(
  accessor: ServicesAccessor,
  sessionId: string,
  use: (cold: ColdSessionMeta) => Promise<T>,
): Promise<T | undefined> {
  const summary = await accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return undefined;
  const lease = accessor.get(ISessionLockService).lease(sessionId);
  try {
    const docs = accessor.get(IAtomicDocumentStore);
    const metaScope = sessionScopeOf(
      projectPersistenceScope(accessor.get(IBootstrapService).scope('sessions'), summary.workspaceId),
      sessionId,
    );
    let raw = await docs.get<SessionMeta>(metaScope, 'state.json');
    let legacyMetaScope: string | undefined;
    if (raw === undefined) {
      legacyMetaScope = legacySessionMetaScopeOf(metaScope);
      raw = await docs.get<SessionMeta>(legacyMetaScope, 'state.json');
    }
    if (raw === undefined) return undefined;
    return await use({
      summary,
      persisted: normalizeSessionMeta(raw, sessionId),
      write: async (next) => {
        const local = next.environmentId === undefined || next.environmentId === LOCAL_ENVIRONMENT_ID;
        const workspaceRoot = local
          ? (await accessor.get(IProjectService).get(summary.workspaceId))?.root
          : undefined;
        const cwd = local
          ? (next.environmentCwd ?? workspaceRoot ?? next.cwd ?? summary.cwd)
          : (next.cwd ?? summary.cwd);
        await docs.set(metaScope, 'state.json', encodeSessionMeta(next));
        if (legacyMetaScope !== undefined) await docs.delete(legacyMetaScope, 'state.json');
        accessor.get(ISessionIndexMirror).record(
          buildSessionSummary({
            id: sessionId,
            workspaceId: summary.workspaceId,
            cwd,
            environmentId: next.environmentId,
            environmentCwd: next.environmentCwd,
            title: next.title,
            lastPrompt: next.lastPrompt,
            createdAt: next.createdAt,
            updatedAt: next.updatedAt,
            archived: next.archived,
            archivedAt: next.archivedAt,
            custom: next.custom,
            lastTurnReason: next.lastTurnReason,
          }),
        );
      },
    });
  } finally {
    lease.release();
  }
}
