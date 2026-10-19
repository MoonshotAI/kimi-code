import { ScopeActivation } from '#/_base/di/instantiation';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AgentSkillService, IAgentSkillService } from './skillService';
import { ISkillTool } from './tools/skill';
import { SkillTool } from './tools/skillTool';

export class SkillFeature extends Feature {
  static override readonly name = 'skill';

  constructor() {
    super();
    this.contributeAgentService(IAgentSkillService, AgentSkillService, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeTool(ISkillTool, SkillTool, { name: 'Skill', domain: 'skill' });
  }
}

registerFeature(SkillFeature);
