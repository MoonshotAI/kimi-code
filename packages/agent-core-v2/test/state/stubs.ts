/**
 * Test doubles for the `state` domain: registers real `StateRegistry`
 * instances for the three per-scope state service tokens.
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentStateService } from '#/agent/state/agentState';
import { StateService } from '#/app/state/stateService';
import { IStateService } from '#/app/state/state';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionStateService } from '#/session/state/sessionState';

export function registerStateServices(reg: ServiceRegistration): void {
  reg.defineInstance(IStateService, new StateService());
  reg.defineInstance(ISessionStateService, new SessionStateService());
  reg.defineInstance(IAgentStateService, new AgentStateService());
}
