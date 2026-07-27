/**
 * `tools` domain (L7) — `ISkillTool` contract (the `Skill` tool).
 *
 * Public contract of the `Skill` collaboration tool that lets the LLM
 * proactively invoke an inline registered skill: the model-facing
 * `SkillToolInputSchema` / `SkillToolInput`, the tool-owned anti-loop
 * constants — `MAX_SKILL_QUERY_DEPTH` caps Skill→Skill recursion so a skill
 * that re-invokes itself (or chains into another) cannot recurse without
 * bound, and `NestedSkillTooDeepError` is raised when a chain exceeds it —
 * and the `ISkillTool` DI decorator that the implementation (`skillTool.ts`)
 * registers against via `registerAgentToolService`. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

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

export interface ISkillTool extends AgentTool<SkillToolInput> { readonly _serviceBrand: undefined }
export const ISkillTool = createDecorator<ISkillTool>('skillTool');
