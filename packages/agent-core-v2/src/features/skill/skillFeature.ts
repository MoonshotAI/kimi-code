import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { skillAgentRuntimeProvider } from './skillAgentRuntime';
import { ISkillTool } from './tools/skill';
import { SkillTool } from './tools/skillTool';

export class SkillFeature extends Feature {
  static override readonly name = 'skill';

  constructor() {
    super();
    this.contributeAgentRuntime(skillAgentRuntimeProvider);
    this.contributeTool(ISkillTool, SkillTool, { name: 'Skill', domain: 'skill' });
  }
}

registerFeature(SkillFeature);
