/**
 * `skillDisclosure` domain (L4) — effective model-visible skill projection.
 *
 * Defines the Agent-scoped service that resolves a structured skill names plus
 * listing snapshot and records the names already disclosed to the model
 * together with the render generation of the disclosure that wrote them.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SkillDisclosureSnapshot {
  readonly names: readonly string[];
  readonly listing: string;
}

export interface SkillDisclosureFloor {
  readonly names: readonly string[];
  readonly renderGeneration: number;
}

export interface IAgentSkillDisclosureService {
  readonly _serviceBrand: undefined;

  resolve(skillActive: boolean): Promise<SkillDisclosureSnapshot>;
  disclosedNames(): readonly string[] | undefined;
  disclosedFloor(): SkillDisclosureFloor | undefined;
  markDisclosed(names: readonly string[], renderGeneration: number): void;
}

export const IAgentSkillDisclosureService: ServiceIdentifier<IAgentSkillDisclosureService> =
  createDecorator<IAgentSkillDisclosureService>('agentSkillDisclosureService');
