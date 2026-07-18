import { createDecorator } from "#/_base/di/instantiation";
import type { SkillActivationOrigin } from '#/agent/contextMemory/types';
import type { Turn } from '#/agent/loop/loop';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<Turn>;
  recordModelToolActivation(origin: SkillActivationOrigin): void;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
