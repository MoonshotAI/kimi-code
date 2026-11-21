import {
  CHILD_SESSION_KIND_KEY,
  ErrorCodes,
  Error2,
  ISessionContext,
  ISessionMetadata,
  PARENT_SESSION_ID_KEY,
  resumeSessionById,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SessionMeta } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { UpdateSessionProfileRequest } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'cwd',
  'goal',
  PARENT_SESSION_ID_KEY,
  CHILD_SESSION_KIND_KEY,
]);

export function customSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => !RESERVED_METADATA_KEYS.has(key)),
  );
}

function reservedSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => RESERVED_METADATA_KEYS.has(key)),
  );
}

export async function updateSessionProfile(
  core: Scope,
  sessionId: string,
  body: Pick<UpdateSessionProfileRequest, 'title' | 'metadata'>,
): Promise<SessionMeta & { readonly workspaceId: string }> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const metadata = session.accessor.get(ISessionMetadata);

  if (typeof body.title === 'string') {
    await metadata.setTitle(body.title);
  }

  if (body.metadata !== undefined && Object.keys(body.metadata).length > 0) {
    const stored = (await metadata.read()).custom;
    await metadata.update({
      custom: { ...customSessionMetadata(body.metadata), ...reservedSessionMetadata(stored) },
    });
  }

  return liveSessionFields(session);
}

export async function liveSessionFields(
  session: ISessionScopeHandle,
): Promise<SessionMeta & { readonly workspaceId: string }> {
  return {
    ...(await session.accessor.get(ISessionMetadata).read()),
    workspaceId: session.accessor.get(ISessionContext).workspaceId,
  };
}
