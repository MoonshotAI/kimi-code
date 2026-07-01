import { createDecorator } from '#/_base/di';

export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface IUserToolService {
  readonly _serviceBrand: undefined;

  register(input: UserToolRegistration): void;
  unregister(name: string): void;
}

export const IUserToolService = createDecorator<IUserToolService>('agentUserToolService');
