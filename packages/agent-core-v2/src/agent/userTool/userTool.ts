import { createDecorator } from '#/_base/di/instantiation';
import type { ToolDisclosure } from '#/tool/toolContract';

export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly disclosure?: ToolDisclosure;
}

export interface IAgentUserToolService {
  readonly _serviceBrand: undefined;

  list(): readonly UserToolRegistration[];
  inheritUserTools(parent: IAgentUserToolService): void;
  register(input: UserToolRegistration): void;
  unregister(name: string): void;
}

export const IAgentUserToolService = createDecorator<IAgentUserToolService>('agentUserToolService');
