import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { RequestModel, TurnModelStep } from '#/agent/loop/turnOps';

export interface AgentRequestAttribution {
  readonly userInputId?: string;
  readonly parentRequestId?: string;
  readonly activeRequestId?: string;
  readonly lastRequestId?: string;
}

export interface ISessionRequestAttributionService {
  readonly _serviceBrand: undefined;

  of(agentId: string): AgentRequestAttribution;
  noteUserInput(agentId: string, userInputId: string): void;
  noteActiveRequest(agentId: string, requestId: string | undefined, active?: boolean, source?: { turnId: number; step?: number }): void;
  noteSubagentDispatch(agentId: string, parentAgentId: string, turnId?: number): AgentRequestAttribution;
  noteModel(agentId: string, turnId: number, step: number, model: RequestModel): void;
  finishModelSteps(agentId: string, turnId: number): TurnModelStep[] | undefined;
}

export const ISessionRequestAttributionService: ServiceIdentifier<ISessionRequestAttributionService> =
  createDecorator<ISessionRequestAttributionService>('sessionRequestAttributionService');
