import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { EnvironmentBinding } from '#/environment/environment';

export interface IAgentEnvironmentBindingService {
  readonly _serviceBrand: undefined;
  readonly current: EnvironmentBinding;
  readonly onDidChange: Event<EnvironmentBinding>;
  set(binding: EnvironmentBinding): EnvironmentBinding;
  switch(environmentId: string, cwd?: string): EnvironmentBinding;
  connectAndSwitch(environmentId: string, cwd?: string): Promise<EnvironmentBinding>;
  connectAndSwitchInTurn(environmentId: string, cwd?: string): Promise<EnvironmentBinding>;
}

export const IAgentEnvironmentBindingService: ServiceIdentifier<IAgentEnvironmentBindingService> = createDecorator<IAgentEnvironmentBindingService>('agentEnvironmentBindingService');

export interface IAgentEnvironmentBindingSeed {
  readonly _serviceBrand: undefined;
  readonly binding: EnvironmentBinding;
}

export const IAgentEnvironmentBindingSeed: ServiceIdentifier<IAgentEnvironmentBindingSeed> = createDecorator<IAgentEnvironmentBindingSeed>('agentEnvironmentBindingSeed');
