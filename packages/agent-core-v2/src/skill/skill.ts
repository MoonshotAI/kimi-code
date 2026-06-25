import { createDecorator } from "#/_base/di";
import type { ExecutableToolResult } from '../../../loop';
import type { SkillCatalog } from '../../../skill';
import type { Turn } from '../types';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

export interface ModelSkillActivationInput extends SkillActivationInput {
  readonly queryDepth?: number;
}

export interface AgentSkillServiceOptions {
  readonly catalog?: SkillCatalog | null;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Turn;
  activateFromModel(input: ModelSkillActivationInput): ExecutableToolResult;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
