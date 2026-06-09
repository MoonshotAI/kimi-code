import { escapeXml } from '#/utils/xml-escape';
import type { SkillSource } from '../../skill';

export type SkillPromptTrigger = 'user-slash' | 'model-tool';

export interface RenderSkillPromptInput {
  readonly skillName: string;
  readonly skillArgs: string;
  readonly skillContent: string;
  readonly skillSource?: SkillSource | undefined;
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

export function renderModelToolSkillPrompt(input: RenderSkillPromptInput): string {
  return [
    'Skill tool loaded instructions for this request. Follow them.',
    '',
    renderSkillLoadedBlock({ ...input, trigger: 'model-tool' }),
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
    ['args', input.skillArgs],
  ];

  return attrs
    .filter((item): item is readonly [string, string] => item[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
}
