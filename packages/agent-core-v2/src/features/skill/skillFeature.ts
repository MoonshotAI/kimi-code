import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { skillAgentRuntimeProvider } from './skillAgentRuntime';
import { ISessionSkillCatalog } from './session/skillCatalog';
import { SkillTool } from './tools/skillTool';

export class SkillFeature extends Feature {
  static override readonly name = 'skill';

  constructor() {
    super();
    this.contributeAgentRuntime(skillAgentRuntimeProvider);
    this.contributeTool({
      name: 'Skill',
      domain: 'skill',
      create: (ctx) =>
        new SkillTool(
          ctx.get(ISessionSkillCatalog),
          ctx.get(IAgentLifecycleService),
          ctx.host.scopeContext,
          ctx.get(ISessionContext),
        ),
    });
  }
}

registerFeature(SkillFeature);
