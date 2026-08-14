/**
 * `skill` domain — user-slash skill activation contract.
 *
 * `SkillActivationInput` carries the slash name and raw args, plus optional
 * edge-resolved attachment parts (`content`) that the activation appends after
 * the rendered skill prompt in its user message. `IAgentSkillService` starts
 * the activation turn (`activate`), submits one prompt preceded by one or more
 * skill activations as a single grouped submission (`promptWithSkills`), and
 * records model-tool activations without a turn (`recordModelToolActivation`).
 * Bound at Agent scope.
 */

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
  readonly submissionId?: string;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<PromptLaunchResult>;
  promptWithSkills(input: PromptWithSkillsInput): Promise<PromptLaunchResult | undefined>;
  recordModelToolActivation(origin: SkillActivationOrigin): void;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
