/**
 * `skill` domain (L3) — `ISkillRegistry` and `ISkillService` implementation.
 *
 * Owns the skill registry and per-agent skill activation; reads configuration
 * through `config`, logs through `log`, persists records through `records`, and
 * observes turns through `turn`. Registry bound at Session scope; service bound
 * at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/config/config';
import { ILogService } from '#/log/log';
import { IAgentRecords } from '#/records/records';
import { ITurnService } from '#/turn/turn';

import {
  type SkillDefinition,
  ISkillRegistry,
  ISkillService,
} from './skill';

export class SkillRegistry implements ISkillRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly skills = new Map<string, SkillDefinition>();
  private roots: readonly string[] = [];

  constructor(
    @IConfigService _config: IConfigService,
    @ILogService _log: ILogService,
  ) {}

  loadRoots(roots: readonly string[]): Promise<void> {
    this.roots = roots;
    return Promise.resolve();
  }

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  list(): readonly SkillDefinition[] {
    return [...this.skills.values()];
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }
}

export class SkillService implements ISkillService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISkillRegistry private readonly registry: ISkillRegistry,
    @IAgentRecords _records: IAgentRecords,
    @ITurnService private readonly turn: ITurnService,
  ) {}

  async activate(name: string): Promise<void> {
    const skill = this.registry.get(name);
    if (skill === undefined) {
      throw new Error(`SkillService.activate: unknown skill '${name}'`);
    }
    return this.turn.prompt(`Activate skill: ${skill.name}`);
  }
}

registerScopedService(LifecycleScope.Session, ISkillRegistry, SkillRegistry, InstantiationType.Delayed, 'skill');
registerScopedService(LifecycleScope.Agent, ISkillService, SkillService, InstantiationType.Delayed, 'skill');
