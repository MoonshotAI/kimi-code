/**
 * `skill` domain — user-slash skill activation contract.
 *
 * `SkillActivationInput` carries the slash name and raw args, plus optional
 * edge-resolved attachment parts (`content`) that the activation appends after
 * the rendered skill prompt in its user message. `IAgentSkillService`
 * delivers activations (`activate` — steered into the running turn when busy,
 * launched as a fresh turn when idle), submits one prompt with one or more
 * skill activations bundled into the same user message (`promptWithSkills` —
 * the rendered skill blocks precede the caller's parts in the content and the
 * activation metadata rides the prompt's origin, so the bundle is a single
 * turn and a single undo unit), and records model-tool activations without a
 * turn (`recordModelToolActivation`). Bound at Agent scope.
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
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<PromptLaunchResult>;
  promptWithSkills(input: PromptWithSkillsInput): Promise<PromptLaunchResult | undefined>;
  recordModelToolActivation(origin: SkillActivationOrigin): void;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
