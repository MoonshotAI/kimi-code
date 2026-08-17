import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface DateInjectionDisclosure {
  readonly kind: 'date';
  readonly renderGeneration: number;
  readonly localDate: string;
  readonly timeZone: string;
}

export interface IAgentDateChangeService {
  readonly _serviceBrand: undefined;
}

export const IAgentDateChangeService: ServiceIdentifier<IAgentDateChangeService> =
  createDecorator<IAgentDateChangeService>('agentDateChangeService');
