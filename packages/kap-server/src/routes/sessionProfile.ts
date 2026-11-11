import {
  CHILD_SESSION_KIND_KEY,
  ErrorCodes,
  Error2,
  ISessionContext,
  ISessionMetadata,
  PARENT_SESSION_ID_KEY,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SessionWireFields } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionLegacy';
import type { UpdateSessionProfileRequest } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

export function customSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const {
    cwd: _cwd,
    goal: _goal,
    [PARENT_SESSION_ID_KEY]: _parentSessionId,
    [CHILD_SESSION_KIND_KEY]: _childSessionKind,
    ...custom
  } = metadata ?? {};
  return custom;
}

export async function updateSessionProfile(
  core: Scope,
  sessionId: string,
  body: Pick<UpdateSessionProfileRequest, 'title' | 'metadata'>,
): Promise<SessionWireFields> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const metadata = session.accessor.get(ISessionMetadata);

  if (typeof body.title === 'string') {
    await metadata.setTitle(body.title);
  }

  const custom = customSessionMetadata(body.metadata);
  if (Object.keys(custom).length > 0) {
    await metadata.update({ custom });
  }

  const meta = await metadata.read();
  const ctx = session.accessor.get(ISessionContext);
  return {
    id: meta.id,
    workspaceId: ctx.workspaceId,
    root: ctx.cwd,
    title: meta.title,
    lastPrompt: meta.lastPrompt,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    archived: meta.archived,
    archivedAt: meta.archivedAt,
    custom: meta.custom,
  };
}
