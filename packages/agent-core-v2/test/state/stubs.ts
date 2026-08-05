/**
 * Test doubles for the `state` domain: registers real `StateRegistry`
 * instances for the four per-scope state service tokens, chained so each
 * tier's `inspect()` cascade resolves its parent.
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AppStateService } from '#/app/state/appStateService';
import { IAppStateService } from '#/app/state/appState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionStateService } from '#/session/state/sessionState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';

export function registerStateServices(reg: ServiceRegistration): void {
  const app = new AppStateService();
  const workspace = new WorkspaceStateService(app);
  const session = new SessionStateService(workspace);
  const agent = new AgentStateService(session);
  reg.defineInstance(IAppStateService, app);
  reg.defineInstance(IWorkspaceStateService, workspace);
  reg.defineInstance(ISessionStateService, session);
  reg.defineInstance(IAgentStateService, agent);
}
