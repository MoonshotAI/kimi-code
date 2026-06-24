/**
 * `skill` domain (L3) — session skill registry + per-agent skill service.
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
