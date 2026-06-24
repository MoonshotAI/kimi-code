import type { ExecutableTool, ExecutableToolResult, ToolExecution } from '../../../loop';
import {
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillToolInputSchema,
  type SkillToolInput,
} from '../../../tools/builtin/collaboration/skill-tool';
import skillDescriptionTemplate from '../../../tools/builtin/collaboration/skill-tool.md?raw';
import { toInputJsonSchema } from '../../../tools/support/input-schema';
import { matchesGlobRuleSubject } from '../../../tools/support/rule-match';
import { renderPrompt } from '../../../utils/render-prompt';
import type { IAgentSkillService } from './skill';

export interface ModelSkillToolOptions {
  readonly queryDepth?: number;
  readonly initialQueryDepth?: number;
}

export class ModelSkillTool implements ExecutableTool<SkillToolInput> {
  readonly name = 'Skill';
  readonly description: string = renderPrompt(skillDescriptionTemplate, {
    MAX_SKILL_QUERY_DEPTH,
  });
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SkillToolInputSchema);

  constructor(
    private readonly skills: IAgentSkillService,
    private readonly options: ModelSkillToolOptions = {},
  ) {}

  resolveExecution(args: SkillToolInput): ToolExecution {
    return {
      description: `Invoke skill ${args.skill}`,
      display: { kind: 'skill_call', skill_name: args.skill, args: args.args },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.skill),
      execute: () => this.execution(args),
    };
  }

  withInitialQueryDepth(initialQueryDepth: number): ModelSkillTool {
    return new ModelSkillTool(this.skills, {
      ...this.options,
      initialQueryDepth,
    });
  }

  private execution(args: SkillToolInput): ExecutableToolResult {
    const queryDepth = this.options.initialQueryDepth ?? this.options.queryDepth ?? 0;
    if (queryDepth >= MAX_SKILL_QUERY_DEPTH) {
      throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
    }
    return this.skills.activateFromModel({
      name: args.skill,
      args: args.args,
      queryDepth,
    });
  }
}
