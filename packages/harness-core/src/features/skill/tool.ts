import {
  createHistoryMessageBuilder,
  type SkillPartMeta,
  type UserMeta,
} from '@moonshot-ai/agent-core/history/index';
import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';
import type { ContentPartMeta, UserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import { isInlineSkillType, type SkillDefinition, type SkillSource } from './catalog/types';
import { renderModelToolSkillPrompt, type SkillPromptTrigger } from './prompt';

import DESCRIPTION from './skill.md?raw';

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

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: SkillPromptTrigger;
  readonly skillType?: string | undefined;
  readonly skillPath?: string | undefined;
  readonly skillSource?: SkillSource | undefined;
}

export interface SkillToolCatalog {
  get(name: string): SkillDefinition | undefined;
  renderSkillPrompt(
    skill: SkillDefinition,
    rawArgs: string,
    context?: { readonly sessionId?: string },
  ): string;
}

export interface SkillToolDeps {
  readonly catalog: SkillToolCatalog;
  readonly agentId: string;
  readonly sessionId: string;
  readonly fire: (event: RuntimeEvent) => void;
  readonly submit: (message: UserMessage, meta?: UserMeta) => unknown;
}

export const SKILL_TOOL_NAME = 'Skill';

export function createSkillTool(deps: SkillToolDeps): ToolDefinition {
  return {
    name: SKILL_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description:
            'The exact name of the skill to invoke, spelled as it appears in the current skill listing (e.g. "commit", "pdf").',
        },
        args: {
          type: 'string',
          description:
            'Optional argument string for the skill, written like a command line (e.g. `-m "fix bug"`, `123`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill\'s placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing `ARGUMENTS:` line. Omit it only when there is nothing to pass.',
        },
      },
      required: ['skill'],
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      const raw = toolCall.arguments ?? '{}';
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return errorResult(`invalid Skill arguments: ${raw}`);
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return errorResult(`invalid Skill arguments: ${raw}`);
      }
      const { skill, args } = parsed as { skill?: unknown; args?: unknown };
      if (typeof skill !== 'string' || skill.length === 0) {
        return errorResult(`invalid Skill arguments: ${raw}`);
      }
      return executeModelSkill(deps, { skill, args: typeof args === 'string' ? args : undefined }, 0);
    },
  };
}

export async function executeModelSkill(
  deps: SkillToolDeps,
  args: SkillToolInput,
  queryDepth: number,
): Promise<ToolResult> {
  const currentDepth = queryDepth;
  if (currentDepth >= MAX_SKILL_QUERY_DEPTH) {
    throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
  }

  const skill = deps.catalog.get(args.skill);
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
  const trigger: SkillPromptTrigger = currentDepth > 0 ? 'nested-skill' : 'model-tool';
  const activationId = crypto.randomUUID();
  const origin: SkillActivationOrigin = {
    kind: 'skill_activation',
    activationId,
    skillName: skill.name,
    skillArgs: skillArgs.length > 0 ? skillArgs : undefined,
    trigger,
    skillType: skill.metadata.type,
    skillPath: skill.path,
    skillSource: skill.source,
  };
  const skillContent = deps.catalog.renderSkillPrompt(skill, skillArgs, {
    sessionId: deps.sessionId,
  });
  const partMeta: SkillPartMeta & ContentPartMeta = {
    kind: 'skill',
    activationId,
    skillName: skill.name,
    skillArgs: origin.skillArgs,
    skillType: skill.metadata.type,
    skillPath: skill.path,
    skillSource: skill.source,
  };
  const message = createHistoryMessageBuilder()
    .xml(
      renderModelToolSkillPrompt({
        skillName: skill.name,
        skillArgs,
        skillContent,
        skillSource: skill.source,
        skillDir: skill.dir,
        trigger,
      }),
      'text/xml',
      partMeta,
    )
    .userMessage();
  deps.fire({
    type: 'skill.activated',
    agentId: deps.agentId,
    activationId,
    skillName: skill.name,
    trigger,
    skillArgs: origin.skillArgs,
    skillPath: skill.path,
    skillSource: skill.source,
  });
  deps.submit(message, { origin });
  return textResult(`Skill "${skill.name}" loaded inline. Follow its instructions.`);
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
