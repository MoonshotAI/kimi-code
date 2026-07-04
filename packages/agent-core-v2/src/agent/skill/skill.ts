import { createDecorator } from "#/_base/di";
import type { SkillActivationOrigin } from '#/agent/contextMemory';
import type { Turn } from '#/agent/turn';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<Turn>;
  /**
   * Records a model-tool skill activation (an inline skill loaded through the
   * `Skill` tool) without opening a new turn — the tool builds and steers its
   * own message into the current turn. Publishes the activation and emits
   * telemetry, matching the user-slash `activate` path's side effects.
   */
  recordModelToolActivation(origin: SkillActivationOrigin): void;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
