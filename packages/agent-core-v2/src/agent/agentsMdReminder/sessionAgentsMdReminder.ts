import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import { IAgentAgentsMdReminderService } from './agentsMdReminder';

export interface ISessionAgentsMdReminderService {
  readonly _serviceBrand: undefined;
  attach(agent: AgentContext): void;
  of(agent: AgentContext): IAgentAgentsMdReminderService;
}

export const ISessionAgentsMdReminderService: ServiceIdentifier<ISessionAgentsMdReminderService> =
  createDecorator<ISessionAgentsMdReminderService>('sessionAgentsMdReminderService');
