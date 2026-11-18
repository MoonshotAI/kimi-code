import { randomUUID } from 'node:crypto';

import type { ContextMessage, SkillActivationOrigin } from '#/agent/contextMemory/types';
import { historyEntryFromContext } from '#/agent/loop/history';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { renderModelToolSkillPrompt } from '#/features/skill/prompt';
import { IAgentSkillService } from '#/features/skill/skillService';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { isInlineSkillType, normalizeSkillName } from '#/features/skill/catalog/types';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
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
  private workspaceDir?: string;

  constructor(
    @ISessionSkillCatalog private readonly catalog: ISessionSkillCatalog,
    @IAgentSkillService private readonly skill: IAgentSkillService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentToolResultTruncationService private readonly truncation: IAgentToolResultTruncationService,
  ) {}

  resolveExecution(args: SkillToolInput): ToolExecution {
    const context = this.queryDepth === 0 && this.workspaceDir === undefined
      ? this.skill.modelToolContext()
      : { queryDepth: this.queryDepth, workspaceDir: this.workspaceDir };
    return {
      description: `Invoke skill ${args.skill}`,
      display: { kind: 'skill_call', skill_name: args.skill, args: args.args },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.skill),
      execute: (executionContext) => executeModelSkill(
        this.catalog,
        this.skill,
        this.loop,
        this.truncation,
        args,
        context.queryDepth,
        this.sessionContext.sessionId,
        executionContext.toolCallId,
        context.workspaceDir,
      ),
    };
  }

  withInitialQueryDepth(initialQueryDepth: number, workspaceDir?: string): SkillTool {
    const clone = new SkillTool(
      this.catalog,
      this.skill,
      this.sessionContext,
      this.loop,
      this.truncation,
    );
    clone.queryDepth = initialQueryDepth;
    clone.workspaceDir = workspaceDir;
    return clone;
  }
}

export async function executeModelSkill(
  catalog: ISessionSkillCatalog,
  skillService: IAgentSkillService,
  loop: IAgentLoopService,
  truncation: IAgentToolResultTruncationService,
  args: SkillToolInput,
  queryDepth: number,
  sessionId: string,
  toolCallId: string,
  parentWorkspaceDir?: string,
): Promise<ExecutableToolResult> {
  const currentDepth = queryDepth;
  if (currentDepth >= MAX_SKILL_QUERY_DEPTH) {
    throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
  }

  await catalog.ready;
  const skill = args.path === undefined && parentWorkspaceDir !== undefined
    ? catalog.catalog.listSkills().find((candidate) =>
        candidate.workspaceDir === parentWorkspaceDir &&
        normalizeSkillName(candidate.name) === normalizeSkillName(args.skill)
      ) ?? catalog.catalog.getSkill(args.skill)
    : catalog.catalog.getSkill(args.skill, args.path);
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
  const truncated = await truncation.truncateForModel({
    toolName: 'Skill',
    toolCallId,
    result: { output: skillContent },
  });
  const message: ContextMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: renderModelToolSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent: truncated.output,
          skillSource: skill.source,
          skillDir: skill.dir,
          trigger,
        }),
      },
    ],
    origin,
  };
  skillService.recordModelToolActivation(origin, currentDepth + 1);
  loop.remind(historyEntryFromContext(message));
  return {
    output: `Skill "${skill.name}" loaded inline. Follow its instructions.`,
  };
}

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}
