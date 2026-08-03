import { escapeXml } from '#/utils/xml-escape';
import type { SkillSource } from '../../skill';

export type SkillPromptTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface RenderSkillPromptInput {
  readonly skillName: string;
  readonly skillArgs: string;
  readonly skillContent: string;
  readonly skillSource?: SkillSource | undefined;
  /**
   * Absolute directory containing the skill's SKILL.md and any bundled
   * resources (scripts, templates, data files). Surfaced on the loaded
   * block so the agent can locate those resources with relative paths —
   * without it, a skill that ships helper scripts is unusable unless the
   * author manually embeds `${KIMI_SKILL_DIR}` in the body.
   */
  readonly skillDir?: string | undefined;
}

interface RenderSkillLoadedBlockInput extends RenderSkillPromptInput {
  readonly trigger: SkillPromptTrigger;
}

export function renderUserSlashSkillPrompt(input: RenderSkillPromptInput): string {
  return [
    `User activated the skill "${escapeXml(input.skillName)}". Follow the loaded skill instructions.`,
    '',
    renderSkillLoadedBlock({ ...input, trigger: 'user-slash' }),
  ].join('\n');
}

export interface RenderModelToolSkillPromptInput extends RenderSkillPromptInput {
  readonly trigger: Extract<SkillPromptTrigger, 'model-tool' | 'nested-skill'>;
}

export function renderModelToolSkillPrompt(input: RenderModelToolSkillPromptInput): string {
  return [
    'Skill tool loaded instructions for this request. Follow them.',
    '',
    renderSkillLoadedBlock({ ...input, trigger: input.trigger }),
  ].join('\n');
}

export function renderSkillLoadedBlock(input: RenderSkillLoadedBlockInput): string {
  return [
    `<kimi-skill-loaded${renderSkillAttributes(input)}>`,
    input.skillContent,
    '</kimi-skill-loaded>',
  ].join('\n');
}

function renderSkillAttributes(input: RenderSkillLoadedBlockInput): string {
  const attrs: ReadonlyArray<readonly [string, string | undefined]> = [
    ['name', input.skillName],
    ['trigger', input.trigger],
    ['source', input.skillSource],
    ['dir', input.skillDir],
    ['args', input.skillArgs],
  ];

  return attrs
    .filter((item): item is readonly [string, string] => item[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
}
