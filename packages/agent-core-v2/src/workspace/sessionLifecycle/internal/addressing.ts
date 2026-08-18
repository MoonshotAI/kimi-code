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

export function legacySessionMetaScopeOf(sessionScope: string): string {
  return `${sessionScope}/session-meta`;
}
