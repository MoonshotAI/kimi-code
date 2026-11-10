import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface AgentCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly source: string;
}

export interface IAgentCommandService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  list(): readonly AgentCommandInfo[];
  run(name: string, args?: string): Promise<void>;
}

export const IAgentCommandService: ServiceIdentifier<IAgentCommandService> =
  createDecorator<IAgentCommandService>('agentCommandService');
