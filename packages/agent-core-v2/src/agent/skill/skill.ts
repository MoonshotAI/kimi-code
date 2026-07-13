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
  /**
   * Records a model-tool skill activation (an inline skill loaded through the
   * `Skill` tool) without opening a new turn — the tool returns a
   * `delivery: 'steer'` for the executor to inject into the current turn.
   * Publishes the activation and emits telemetry, matching the user-slash
   * `activate` path's side effects.
   */
  recordModelToolActivation(origin: SkillActivationOrigin): void;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
