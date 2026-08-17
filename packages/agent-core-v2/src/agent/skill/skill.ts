import { createDecorator } from "#/_base/di/instantiation";
import type { SkillActivationOrigin } from '#/agent/contextMemory/types';
import type { PromptLaunchResult } from '#/agent/prompt/prompt';
import type { ContentPart } from '#/kosong/contract/message';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
  readonly content?: readonly ContentPart[];
}

export interface PromptSkillActivation {
  readonly name: string;
  readonly args?: string;
}

export interface PromptWithSkillsInput {
  readonly input: readonly ContentPart[];
  readonly skills: readonly PromptSkillActivation[];
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<PromptLaunchResult>;
  promptWithSkills(input: PromptWithSkillsInput): Promise<PromptLaunchResult | undefined>;
  recordModelToolActivation(origin: SkillActivationOrigin): void;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
