import { randomUUID } from 'node:crypto';

import type { SkillActivationOrigin } from '#/agent/contextMemory/types';
import { renderModelToolSkillPrompt } from '#/features/skill/prompt';
import { AgentSkill, type SkillRuntime } from '#/features/skill/skillAgentRuntime';
import type { ExecutableToolResult, ToolDeliveryMessage, ToolExecution } from '#/tool/toolContract';
import { isInlineSkillType } from '#/features/skill/catalog/types';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';

import {
  ISkillTool,
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillToolInputSchema,
  type SkillToolInput,
} from './skill';
import skillDescriptionTemplate from './skill.md?raw';

export class SkillTool implements ISkillTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Skill';
  readonly description: string = renderPrompt(skillDescriptionTemplate, {
    MAX_SKILL_QUERY_DEPTH,
  });
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SkillToolInputSchema);

  private queryDepth: number = 0;

  private readonly skill: SkillRuntime;

  constructor(
    @ISessionSkillCatalog private readonly catalog: ISessionSkillCatalog,
    @IAgentLifecycleService private readonly manager: IAgentLifecycleService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    this.skill = manager.resolve(scope.agentContext, AgentSkill);
  }

  resolveExecution(args: SkillToolInput): ToolExecution {
    return {
      description: `Invoke skill ${args.skill}`,
      display: { kind: 'skill_call', skill_name: args.skill, args: args.args },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.skill),
      execute: () => this.execution(args),
    };
  }

  withInitialQueryDepth(initialQueryDepth: number): SkillTool {
    const clone = new SkillTool(this.catalog, this.manager, this.scope, this.sessionContext);
    clone.queryDepth = initialQueryDepth;
    return clone;
  }

  private async execution(args: SkillToolInput): Promise<ExecutableToolResult> {
    return executeModelSkill(
      this.catalog,
      this.skill,
      args,
      this.queryDepth,
      this.sessionContext.sessionId,
    );
  }
}

export async function executeModelSkill(
  catalog: ISessionSkillCatalog,
  skillService: SkillRuntime,
  args: SkillToolInput,
  queryDepth: number,
  sessionId: string,
): Promise<ExecutableToolResult> {
  const currentDepth = queryDepth;
  if (currentDepth >= MAX_SKILL_QUERY_DEPTH) {
    throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
  }

  await catalog.ready;
  const skill = catalog.catalog.getSkill(args.skill);
  if (skill === undefined) {
    return errorResult(`Skill "${args.skill}" not found in the current skill listing.`);
  }
  if (skill.metadata.disableModelInvocation === true) {
    return errorResult(
      `Skill "${args.skill}" can only be triggered by the user (model invocation is disabled).`,
    );
  }
  if (!isInlineSkillType(skill.metadata.type)) {
    return errorResult(
      `Skill "${skill.name}" is not an inline skill and cannot be invoked by the model in v1.`,
    );
  }

  const skillArgs = args.args ?? '';
  const trigger = currentDepth > 0 ? 'nested-skill' : 'model-tool';
  const origin: SkillActivationOrigin = {
    kind: 'skill_activation',
    activationId: randomUUID(),
    skillName: skill.name,
    skillArgs: skillArgs.length > 0 ? skillArgs : undefined,
    trigger,
    skillType: skill.metadata.type,
    skillPath: skill.path,
    skillSource: skill.source,
  };
  const skillContent = catalog.catalog.renderSkillPrompt(skill, skillArgs, { sessionId });
  const message: ToolDeliveryMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: renderModelToolSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
          trigger,
        }),
      },
    ],
    toolCalls: [],
    origin,
  };
  skillService.recordModelToolActivation(origin);
  return {
    output: `Skill "${skill.name}" loaded inline. Follow its instructions.`,
    delivery: { kind: 'steer', message },
  };
}

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}
