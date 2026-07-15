/**
 * SkillTool — invoke a registered skill.
 *
 * Collaboration tool that lets the LLM proactively invoke an inline
 * registered skill. Inline skills record their activation through the
 * owning agent; non-inline skill types are intentionally not model-invocable
 * in the v1 default runtime.
 *
 * The model-facing wrapping lives here on purpose: resolving the skill from
 * the catalog, the inline-only / `disableModelInvocation` gates, the `isError`
 * tool result, and the declared `delivery: 'steer'` into the *current* turn all
 * assume the caller is already inside a turn — which is exactly the edge a
 * tool runs at. The tool only declares the `delivery`; the agent (L4) layer
 * performs the actual steer, so the tool never reaches into
 * `IAgentPromptService`. `IAgentSkillService` keeps only the user-slash
 * `activate` primitive (it opens a fresh turn) and the shared activation
 * recording.
 *
 * Anti-loop: `MAX_SKILL_QUERY_DEPTH` caps Skill→Skill recursion so a
 * skill that re-invokes itself (or chains into another) cannot recurse
 * without bound.
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { SkillActivationOrigin } from '#/agent/contextMemory/types';
import { IAgentSkillService } from '#/agent/skill/skill';
import { renderModelToolSkillPrompt } from '#/agent/skill/prompt';
import type { BuiltinTool, ExecutableToolResult, ToolDeliveryMessage, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { isInlineSkillType } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import skillDescriptionTemplate from './skill.md?raw';

export const MAX_SKILL_QUERY_DEPTH = 3;

export class NestedSkillTooDeepError extends Error {
  readonly skillName?: string;
  readonly depth: number;

  constructor(depth: number, skillName?: string) {
    const label = skillName !== undefined ? ` "${skillName}"` : '';
    super(
      `Nested skill invocation${label} exceeded the maximum depth of ${String(depth)} — refusing to recurse further.`,
    );
    this.name = 'NestedSkillTooDeepError';
    this.depth = depth;
    if (skillName !== undefined) this.skillName = skillName;
  }
}

export interface SkillToolInput {
  skill: string;
  args?: string;
}

export const SkillToolInputSchema: z.ZodType<SkillToolInput> = z.object({
  skill: z
    .string()
    .describe(
      'The exact name of the skill to invoke, spelled as it appears in the current skill listing (e.g. "commit", "pdf").',
    ),
  args: z
    .string()
    .optional()
    .describe(
      'Optional argument string for the skill, written like a command line (e.g. `-m "fix bug"`, `123`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill\'s placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing `ARGUMENTS:` line. Omit it only when there is nothing to pass.',
    ),
});

export class SkillTool implements BuiltinTool<SkillToolInput> {
  readonly name = 'Skill';
  readonly description: string = renderPrompt(skillDescriptionTemplate, {
    MAX_SKILL_QUERY_DEPTH,
  });
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SkillToolInputSchema);

  private queryDepth: number = 0;

  constructor(
    @ISessionSkillCatalog private readonly catalog: ISessionSkillCatalog,
    @IAgentSkillService private readonly skill: IAgentSkillService,
    @ISessionContext private readonly sessionContext: ISessionContext,
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

  withInitialQueryDepth(initialQueryDepth: number): SkillTool {
    const clone = new SkillTool(this.catalog, this.skill, this.sessionContext);
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

registerTool(SkillTool);

export async function executeModelSkill(
  catalog: ISessionSkillCatalog,
  skillService: IAgentSkillService,
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
