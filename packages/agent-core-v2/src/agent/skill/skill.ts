import { createDecorator } from "#/_base/di/instantiation";
import type { SkillActivationOrigin } from '#/agent/contextMemory/types';
import type { Turn } from '#/agent/loop/loop';
import type { ContentPart } from '#/kosong/contract/message';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
  /**
   * Extra content parts (already edge-resolved attachments) appended after the
   * rendered skill prompt text part in the activation's user message.
   */
  readonly content?: readonly ContentPart[];
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<Turn>;
  recordModelToolActivation(origin: SkillActivationOrigin): void;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
