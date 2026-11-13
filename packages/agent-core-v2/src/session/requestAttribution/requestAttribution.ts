import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

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
  noteActiveRequest(agentId: string, requestId: string | undefined, active?: boolean): void;
  noteSubagentDispatch(agentId: string, parentAgentId: string): AgentRequestAttribution;
}

export const ISessionRequestAttributionService: ServiceIdentifier<ISessionRequestAttributionService> =
  createDecorator<ISessionRequestAttributionService>('sessionRequestAttributionService');
