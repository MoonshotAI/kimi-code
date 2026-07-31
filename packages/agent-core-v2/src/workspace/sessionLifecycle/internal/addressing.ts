/**
 * `sessionLifecycle` domain — persistence addressing along the handler chain.
 *
 * Pure functions deriving the persistence scope strings and on-disk
 * directories from the handler's `persistenceScope` (`sessions/{wd_id}`):
 * session = `{handlerScope}/{session_id}`, agent =
 * `{sessionScope}/agents/{agent_id}`. Under the local/local runtime these
 * are byte-identical to the layout the pre-Workspace engine wrote, so v1
 * readers (`session_index.jsonl`, snapshot readers) keep working unchanged.
 * Own no scoped state.
 */

import { join } from 'pathe';

export function workspacePersistenceScope(sessionsScope: string, workspaceId: string): string {
  return join(sessionsScope, workspaceId);
}

export function sessionScopeOf(handlerScope: string, sessionId: string): string {
  return `${handlerScope}/${sessionId}`;
}

export function sessionDirOf(homeDir: string, handlerScope: string, sessionId: string): string {
  return join(homeDir, sessionScopeOf(handlerScope, sessionId));
}

export function agentScopeOf(sessionScope: string, agentId: string): string {
  return `${sessionScope}/agents/${agentId}`;
}
