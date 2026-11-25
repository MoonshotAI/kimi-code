import type { ServiceRegistration } from '#/_base/di/test';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AppStateService } from '#/app/state/appStateService';
import { IAppStateService } from '#/app/state/appState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionStateService } from '#/session/state/sessionState';
import { ProjectStateService } from '#/project/state/projectStateService';
import { IProjectStateService } from '#/project/state/projectState';

export function registerStateServices(reg: ServiceRegistration) {
  const app = new AppStateService();
  const workspace = new ProjectStateService(app);
  const session = new SessionStateService();
  const agent = new AgentStateService(session);
  reg.defineInstance(IAppStateService, app);
  reg.defineInstance(IProjectStateService, workspace);
  reg.defineInstance(ISessionStateService, session);
  reg.defineInstance(IAgentStateService, agent);
  return { app, workspace, session, agent };
}
