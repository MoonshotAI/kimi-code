import {
  ErrorCodes,
  Error2,
  IAgentEnvironmentBindingService,
  IAgentLifecycleService,
  IAgentLoopService,
  ISessionActivityView,
  MAIN_AGENT_ID,
  closeSessionById,
  getLiveSessionById,
  patchSessionMetadata,
  resumeSessionById,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { LOCAL_ENVIRONMENT_ID } from '@moonshot-ai/agent-core-v2/environment/environment';

export async function repointSession(
  core: Scope,
  sessionId: string,
  directory: string | undefined,
): Promise<ISessionScopeHandle> {
  const live = getLiveSessionById(core.accessor, sessionId);
  if (live?.accessor.get(ISessionActivityView).state().busy === true) {
    throw new Error2(
      ErrorCodes.SESSION_BUSY,
      `Session "${sessionId}" cannot change its working directory while it is busy`,
      { details: { sessionId } },
    );
  }
  const meta = await patchSessionMetadata(core.accessor, sessionId, () => ({
    environmentCwd: directory,
  }));
  await closeSessionById(core.accessor, sessionId);
  const session = meta === undefined ? undefined : await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const main = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  if (main !== undefined) {
    main.accessor.get(IAgentEnvironmentBindingService).bind(LOCAL_ENVIRONMENT_ID, directory);
    const loop = main.accessor.get(IAgentLoopService);
    const bound = loop.bindingSnapshot();
    if (bound.profileName !== undefined) {
      await loop.bindProfile({ profile: bound.profileName, model: bound.modelAlias });
    }
  }
  return session;
}
