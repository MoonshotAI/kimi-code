/**
 * `skill` domain (L3) — session skill registry and per-agent skill service.
 *
 * Defines the public contract for skills: the `SkillDefinition` model, the
 * `ISkillRegistry` used to load roots and register skills, and the
 * `ISkillService` used by agents to activate a skill. `ISkillRegistry` is
 * Session-scoped (one registry per session); `ISkillService` is Agent-scoped
 * (one per agent).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SkillDefinition {
  readonly name: string;
  readonly root: string;
}

export interface ISkillRegistry {
  readonly _serviceBrand: undefined;
  loadRoots(roots: readonly string[]): Promise<void>;
  register(skill: SkillDefinition): void;
  list(): readonly SkillDefinition[];
  get(name: string): SkillDefinition | undefined;
}

export const ISkillRegistry: ServiceIdentifier<ISkillRegistry> =
  createDecorator<ISkillRegistry>('skillRegistry');

export interface ISkillService {
  readonly _serviceBrand: undefined;
  activate(name: string): Promise<void>;
}

export const ISkillService: ServiceIdentifier<ISkillService> =
  createDecorator<ISkillService>('skillService');
