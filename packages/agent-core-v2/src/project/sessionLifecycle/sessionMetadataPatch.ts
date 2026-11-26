import type { ServicesAccessor } from '#/_base/di/instantiation';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { getLiveSessionById } from '#/app/sessionManager/sessionLookup';
import { IProjectService } from '#/app/project/project';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import {
  ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
} from '#/session/sessionMetadata/sessionMetadata';

import { withColdSessionMeta } from './internal/coldSessionMeta';

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
  return withColdSessionMeta(accessor, sessionId, async ({ summary, persisted, write }) => {
    const patch = patcher(persisted);
    if (patch === undefined) return persisted;
    const nextMeta: SessionMeta = { ...persisted, ...patch };
    const local =
      nextMeta.environmentId === undefined || nextMeta.environmentId === LOCAL_ENVIRONMENT_ID;
    const workspaceRoot = local
      ? (await accessor.get(IProjectService).get(summary.workspaceId))?.root
      : undefined;
    await write(
      nextMeta,
      local ? (nextMeta.environmentCwd ?? workspaceRoot ?? nextMeta.cwd ?? summary.cwd) : undefined,
    );
    return nextMeta;
  });
}
