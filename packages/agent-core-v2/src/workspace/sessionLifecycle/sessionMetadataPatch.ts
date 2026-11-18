import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { getLiveSessionById } from '#/app/sessionManager/sessionLookup';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import {
  ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
} from '#/session/sessionMetadata/sessionMetadata';
import { normalizeSessionMeta, encodeSessionMeta } from '#/session/sessionMetadata/sessionMetadataService';

import { sessionScopeOf, legacySessionMetaScopeOf, workspacePersistenceScope } from './internal/addressing';

export type SessionMetadataPatcher = (meta: SessionMeta) => SessionMetaPatch | undefined;

export async function patchSessionMetadata(
  accessor: ServicesAccessor,
  sessionId: string,
  patcher: SessionMetadataPatcher,
): Promise<SessionMeta | undefined> {
  const manager = accessor.get(ISessionManager);
  await manager.whenResumeSettled(sessionId).catch(() => undefined);
  return manager.withLifecycleSerialization(sessionId, async () => {
    const live = getLiveSessionById(accessor, sessionId);
    if (live === undefined) return patchColdSessionMetadata(accessor, sessionId, patcher);
    const metadata = live.accessor.get(ISessionMetadata);
    const patch = patcher(await metadata.read());
    if (patch !== undefined) await metadata.update(patch, { touchUpdatedAt: false });
    return metadata.read();
  });
}

async function patchColdSessionMetadata(
  accessor: ServicesAccessor,
  sessionId: string,
  patcher: SessionMetadataPatcher,
): Promise<SessionMeta | undefined> {
  const summary = await accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return undefined;
  const lease = accessor.get(ISessionLockService).lease(sessionId);
  try {
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
    if (raw === undefined) return undefined;
    const persisted = normalizeSessionMeta(raw, sessionId);
    const patch = patcher(persisted);
    if (patch === undefined) return persisted;
    const nextMeta: SessionMeta = { ...persisted, ...patch };
    await docs.set(metaScope, 'state.json', encodeSessionMeta(nextMeta));
    if (legacyMetaScope !== undefined) await docs.delete(legacyMetaScope, 'state.json');
    const local =
      nextMeta.environmentId === undefined || nextMeta.environmentId === LOCAL_ENVIRONMENT_ID;
    const workspaceRoot = local
      ? (await accessor.get(IWorkspaceService).get(summary.workspaceId))?.root
      : undefined;
    accessor.get(ISessionIndexMirror).record(
      buildSessionSummary({
        id: sessionId,
        workspaceId: summary.workspaceId,
        cwd: local
          ? (nextMeta.environmentCwd ?? workspaceRoot ?? nextMeta.cwd ?? summary.cwd)
          : (nextMeta.cwd ?? summary.cwd),
        environmentId: nextMeta.environmentId,
        environmentCwd: nextMeta.environmentCwd,
        title: nextMeta.title,
        lastPrompt: nextMeta.lastPrompt,
        createdAt: nextMeta.createdAt,
        updatedAt: nextMeta.updatedAt,
        archived: nextMeta.archived,
        archivedAt: nextMeta.archivedAt,
        custom: nextMeta.custom,
        lastTurnReason: nextMeta.lastTurnReason,
      }),
    );
    return nextMeta;
  } finally {
    lease.release();
  }
}
